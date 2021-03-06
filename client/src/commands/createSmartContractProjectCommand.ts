/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
*/
'use strict';
import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import { Reporter } from '../util/Reporter';
import { VSCodeBlockchainOutputAdapter } from '../logging/VSCodeBlockchainOutputAdapter';
import { CommandUtil } from '../util/CommandUtil';
import * as path from 'path';
import { UserInputUtil } from './UserInputUtil';
import * as fs from 'fs-extra';
import * as yeoman from 'yeoman-environment';
import { YeomanAdapter } from '../util/YeomanAdapter';
import * as util from 'util';
import { ExtensionUtil } from '../util/ExtensionUtil';
import { LogType } from '../logging/OutputAdapter';
import * as semver from 'semver';

const localize: nls.LocalizeFunc = nls.loadMessageBundle();

class GeneratorDependencies {
    needYo: boolean = false;
    needGenFab: boolean = false;

    constructor(options?: object) {
        Object.assign(this, options);
    }

    missingDependencies(): boolean {
        return this.needYo || this.needGenFab;
    }
}

export async function createSmartContractProject(generator: string = 'fabric:contract'): Promise<void> {
    console.log('create Smart Contract Project');
    // Create and show output channel
    const outputAdapter: VSCodeBlockchainOutputAdapter = VSCodeBlockchainOutputAdapter.instance();

    // check for yo and generator-fabric
    const dependencies: GeneratorDependencies = await checkGeneratorDependenciesWithProgress();
    if (!dependencies) {
        return;
    }

    // Install missing node modules
    if (dependencies.missingDependencies()) {
        const successful: boolean = await installGeneratorDependenciesWithProgress(dependencies);
        if (!successful) {
            return;
        }
    }

    // If the user is on a Mac (Darwin)
    if (process.platform === 'darwin') {
        // Check to see if Xcode is installed (and assume gcc and other dependencies have been installed)
        const isInstalled: boolean = await isXcodeInstalled();
        if (!isInstalled) {
            return;
        }
    }

    let smartContractLanguageOptions: string[];
    let smartContractLanguage: string;
    outputAdapter.log(LogType.INFO, 'Getting smart contract languages...');
    try {
        smartContractLanguageOptions = await getSmartContractLanguageOptionsWithProgress();
    } catch (error) {
        outputAdapter.log(LogType.ERROR, `Issue determining available smart contract language options: ${error.message}`, `Issue determining available smart contract language options: ${error.toString()}`);
        return;
    }

    const smartContractLanguagePrompt: string = localize('smartContractLanguage.prompt', 'Choose smart contract language (Esc to cancel)');
    smartContractLanguage = await UserInputUtil.showLanguagesQuickPick(smartContractLanguagePrompt, smartContractLanguageOptions);
    if (!smartContractLanguage) {
        // User has cancelled the QuickPick box
        return;
    }

    smartContractLanguage = smartContractLanguage.toLowerCase();

    const quickPickItems: string[] = [UserInputUtil.BROWSE_LABEL];
    const openDialogOptions: vscode.OpenDialogOptions = {
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Save',
        filters: undefined
    };

    const folderUri: vscode.Uri = await UserInputUtil.browseEdit('Choose the location to save the smart contract', quickPickItems, openDialogOptions, undefined, true) as vscode.Uri;
    if (!folderUri) {
        return;
    }
    const folderPath: string = folderUri.fsPath;
    const folderName: string = path.basename(folderPath);

    const openMethod: string = await UserInputUtil.showFolderOptions('Choose how to open your new project');

    if (!openMethod) {
        return;
    }

    try {
        // tslint:disable-next-line
        let env = yeoman.createEnv([], {}, new YeomanAdapter());

        env.lookup = util.promisify(env.lookup);
        env.run = util.promisify(env.run);
        await env.lookup();

        // tslint:disable-next-line
        const packageJson: any = ExtensionUtil.getPackageJSON();
        const runOptions: any = {
            'destination': folderPath,
            'language': smartContractLanguage,
            'name': folderName,
            'version': '0.0.1',
            'description': 'My Smart Contract',
            'author': 'John Doe',
            'license': 'Apache-2.0',
            'skip-install': !packageJson.production
        };

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'IBM Blockchain Platform Extension',
            cancellable: false
        }, async (progress: vscode.Progress<{message: string}>, token: vscode.CancellationToken): Promise<void> => {
            progress.report({message: 'Generating smart contract project'});
            await env.run(generator, runOptions);
        });

        outputAdapter.log(LogType.SUCCESS, 'Successfully generated smart contract project');

        Reporter.instance().sendTelemetryEvent('createSmartContractProject', {contractLanguage: smartContractLanguage});
        // Open the returned folder in explorer, in a new window
        console.log('new smart contract project folder is :' + folderPath);
        await UserInputUtil.openNewProject(openMethod, folderUri);
    } catch (error) {
        outputAdapter.log(LogType.ERROR, `Issue creating smart contract project: ${error.message}`, `Issue creating smart contract project: ${error.toString()}`);
        return;
    }

} // end of createSmartContractProject function

async function checkGeneratorDependenciesWithProgress(): Promise<GeneratorDependencies> {
    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'IBM Blockchain Platform Extension',
        cancellable: false
    }, async (progress: vscode.Progress<{message: string}>): Promise<GeneratorDependencies> => {
        progress.report({message: `Checking smart contract generator dependencies...`});
        return checkGeneratorDependencies();
    });
}

async function checkGeneratorDependencies(): Promise<GeneratorDependencies> {

    // Create and show output channel
    const outputAdapter: VSCodeBlockchainOutputAdapter = VSCodeBlockchainOutputAdapter.instance();

    // Check to see if we have npm installed.
    try {
        await CommandUtil.sendCommand('npm --version');
    } catch (error) {
        console.log('npm not installed');
        outputAdapter.log(LogType.ERROR, 'npm is required before creating a smart contract project');
        return null;
    }

    // Check to see if we have yo (yeoman) installed.
    try {

        // This command should print the long details of the installed yo module.
        const output: string = await CommandUtil.sendCommand('npm ls --depth=0 --global --json --long yo');
        const details: any = JSON.parse(output);
        console.log('yo is installed', details);

    } catch (error) {
        console.log('yo missing');
        // assume generator-fabric isn't installed either
        return new GeneratorDependencies({ needYo: true, needGenFab: true });
    }

    // Check to see if we have generator-fabric installed.
    try {

        // This command should print the long details of the installed generator-fabric module.
        const output: string = await CommandUtil.sendCommand('npm ls --depth=0 --global --json --long generator-fabric');
        const details: any = JSON.parse(output);

        // Grab the version that is installed.
        const versionInstalled: string = details.dependencies['generator-fabric'].version;

        // Grab the version range that we find acceptable.
        const packageJson: any = ExtensionUtil.getPackageJSON();
        const versionRange: string = packageJson.generatorFabricVersion;

        // Check to see if the version range is satisfied.
        const satisfied: boolean = semver.satisfies(versionInstalled, versionRange);

        // If it's not satisfied, we need to install it.
        if (!satisfied) {

            // The users global installation of generator-fabric is out of date
            console.log(`Updating generator-fabric as it is out of date ('${versionInstalled}' does not satisfy '${versionRange}')`);
            await CommandUtil.sendCommandWithOutputAndProgress('npm', ['install', '-g', `generator-fabric@${versionRange}`], 'Updating generator-fabric...', null, null, outputAdapter);
            outputAdapter.log(LogType.SUCCESS, 'Successfully updated to latest version of generator-fabric');

        }
        console.log('generator-fabric is installed', details);
        return new GeneratorDependencies({ needYo: false, needGenFab: false });

    } catch (error) {
        console.log('generator-fabric missing');
        return new GeneratorDependencies({ needYo: false, needGenFab: true });
    }

}

async function installGeneratorDependenciesWithProgress(dependencies: GeneratorDependencies): Promise<boolean> {
    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'IBM Blockchain Platform Extension',
        cancellable: false
    }, async (progress: vscode.Progress<{message: string}>) => {
        progress.report({message: `Installing smart contract generator dependencies...`});
        return installGeneratorDependencies(dependencies);
    });
}

async function installGeneratorDependencies(dependencies: GeneratorDependencies): Promise<boolean> {

    // Create and show output channel
    const outputAdapter: VSCodeBlockchainOutputAdapter = VSCodeBlockchainOutputAdapter.instance();

    // Install missing node modules
    if (dependencies.needYo) {
        outputAdapter.log(LogType.INFO, undefined, 'Installing yo');
        try {
            const yoInstOut: string = await CommandUtil.sendCommand('npm install -g yo');
            outputAdapter.log(LogType.INFO, undefined, yoInstOut);
        } catch (error) {
            outputAdapter.log(LogType.ERROR, `Issue installing yo node module: ${error.message}`, `Issue installing yo node module: ${error.toString()}`);
            return false;
        }
    }

    // it is assumed that if we got here we need to install the generator.
    outputAdapter.log(LogType.INFO, undefined, 'Installing generator-fabric');
    try {
        const genFabInstOut: string = await CommandUtil.sendCommand('npm install -g generator-fabric');
        outputAdapter.log(LogType.INFO, undefined, genFabInstOut);
    } catch (error) {
        outputAdapter.log(LogType.ERROR, `Issue installing generator-fabric module: ${error.message}`, `Issue installing generator-fabric module: ${error.toString()}`);
        return false;
    }
    return true;

}

async function getSmartContractLanguageOptionsWithProgress(): Promise<string[]> {
    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'IBM Blockchain Platform Extension',
        cancellable: false
    }, async (progress: vscode.Progress<{message: string}>): Promise<string[]> => {
        progress.report({message: `Getting smart contract languages...`});
        return getSmartContractLanguageOptions();
    });
}

async function getSmartContractLanguageOptions(): Promise<string[]> {
    let parsedJson: any;
    try {
        parsedJson = await getGeneratorFabricPackageJson();
    } catch (error) {
        throw new Error('Could not load package.json for generator-fabric module');
    }
    if (parsedJson.contractLanguages === undefined) {
        throw new Error('Contract languages not found in package.json for generator-fabric module');
    }
    return parsedJson.contractLanguages;
}

async function getGeneratorFabricPackageJson(): Promise<any> {
    const output: string = await CommandUtil.sendCommand('npm ls --depth=0 --global --json --long generator-fabric');
    const details: any = JSON.parse(output);
    const packagePath: string = path.join(details.dependencies['generator-fabric'].path, 'package.json');
    const packageJson: any = await fs.readJson(packagePath);
    return packageJson;
}

async function isXcodeInstalled(): Promise<any> {
    const outputAdapter: VSCodeBlockchainOutputAdapter = VSCodeBlockchainOutputAdapter.instance();
    try {
        const output: string = await CommandUtil.sendCommand('xcode-select -p'); // Get path of active developer directory
        if (!output || output.includes('unable to get active developer directory')) {
            outputAdapter.log(LogType.ERROR, 'Xcode and the Command Line Tools are required to install smart contract dependencies');
            return false;
        } else {
            return true;
        }
    } catch (error) {
        outputAdapter.log(LogType.ERROR, 'Xcode and the Command Line Tools are required to install smart contract dependencies');
        return false;
    }

}

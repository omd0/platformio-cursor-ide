/**
 * Copyright (c) 2017-present PlatformIO <contact@platformio.org>
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import * as pioNodeHelpers from 'platformio-node-helpers';
import * as projectHelpers from './helpers';

import { disposeSubscriptions, notifyError } from '../utils';
import { ProjectConfigLanguageProvider } from './config';
import ProjectTaskManager from './tasks';
import ProjectTestManager from './tests';
import { STATUS_BAR_PRIORITY_START } from '../constants';
import { extension } from '../main';
import path from 'path';
import vscode from 'vscode';

export default class ProjectManager {
  CONFIG_CHANGED_DELAY = 1; // seconds - reduced for faster response

  constructor() {
    this._taskManager = undefined;
    this._sbEnvSwitcher = undefined;
    this._logOutputChannel = vscode.window.createOutputChannel(
      'PlatformIO: Project Configuration',
    );
    this._configProvider = new ProjectConfigLanguageProvider();
    this._configChangedTimeout = undefined;

    this._pool = new pioNodeHelpers.project.ProjectPool({
      ide: 'vscode',
      api: {
        logOutputChannel: this._logOutputChannel,
        createFileSystemWatcher: vscode.workspace.createFileSystemWatcher,
        createDirSystemWatcher: (dir) =>
          vscode.workspace.createFileSystemWatcher(path.join(dir, '*')),
        withIndexRebuildingProgress: (task) =>
          vscode.window.withProgress(
            {
              location: { viewId: vscode.ProgressLocation.Notification },
              title: 'PlatformIO: Configuring project',
              cancellable: true,
            },
            async (progress, token) =>
              await task(
                (message, increment = undefined) =>
                  progress.report({
                    message,
                    increment: increment,
                  }),
                token,
              ),
          ),
        withTasksLoadingProgress: (task) =>
          vscode.window.withProgress(
            {
              location: { viewId: ProjectTaskManager.TASKS_VIEW_ID },
            },
            async () =>
              await vscode.window.withProgress(
                {
                  location: { viewId: vscode.ProgressLocation.Window },
                  title: 'PlatformIO: Loading tasks...',
                },
                task,
              ),
          ),
        onDidChangeProjectConfig: (configPath) => {
          const projectDir = path.dirname(configPath);
          if (this._configChangedTimeout) {
            clearTimeout(this._configChangedTimeout);
            this._configChangedTimeout = undefined;
          }
          this._configChangedTimeout = setTimeout(
            () => {
              this.switchToProject(projectDir, {
                force: true,
              });
              // Always rebuild clangd index when platformio.ini changes
              this.rebuildClangdIndex();
            },
            ProjectManager.CONFIG_CHANGED_DELAY * 1000,
          );
        },
        onDidNotifyError: notifyError.bind(this),
      },
      settings: {
        autoPreloadEnvTasks: extension.getConfiguration('autoPreloadEnvTasks'),
        autoRebuild: extension.getConfiguration('autoRebuildAutocompleteIndex'),
      },
    });

    this.subscriptions = [
      this._pool,
      this._logOutputChannel,
      this._configProvider,
      // Direct watcher for platformio.ini files to ensure we catch all changes
      vscode.workspace.createFileSystemWatcher('**/platformio.ini').onDidChange((uri) => {
        console.log('platformio.ini changed:', uri.fsPath);
        const projectDir = path.dirname(uri.fsPath);
        if (this._configChangedTimeout) {
          clearTimeout(this._configChangedTimeout);
          this._configChangedTimeout = undefined;
        }
        this._configChangedTimeout = setTimeout(
          () => {
            console.log('Triggering clangd rebuild for platformio.ini change');
            this.switchToProject(projectDir, {
              force: true,
            });
            // Always rebuild clangd index when platformio.ini changes
            this.rebuildClangdIndex();
          },
          ProjectManager.CONFIG_CHANGED_DELAY * 1000,
        );
      }),
      vscode.window.onDidChangeActiveTextEditor(() => {
        if (!extension.getConfiguration('activateProjectOnTextEditorChange')) {
          return;
        }
        const projectDir = projectHelpers.getActiveEditorProjectDir();
        if (projectDir) {
          this.switchToProject(projectDir);
          // Initialize clangd support when switching projects via text editor
          setTimeout(() => {
            this.rebuildClangdIndex();
          }, 1000);
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.switchToProject(this.findActiveProjectDir());
        // Initialize clangd support when workspace folders change
        setTimeout(() => {
          this.rebuildClangdIndex();
        }, 1000);
      }),
      vscode.commands.registerCommand('platformio-ide.rebuildProjectIndex', () =>
        this.rebuildClangdIndex(),
      ),
      vscode.commands.registerCommand('platformio-ide.rebuildClangdIndex', () =>
        this.rebuildClangdIndex(),
      ),
      vscode.commands.registerCommand('platformio-ide.refreshProjectTasks', () =>
        this._taskManager.refresh({ force: true }),
      ),
      vscode.commands.registerCommand('platformio-ide.toggleMultiEnvProjectTasks', () =>
        this._taskManager.toggleMultiEnvExplorer(),
      ),
      vscode.commands.registerCommand('platformio-ide._runProjectTask', (task) =>
        this._taskManager.runTask(task),
      ),
      vscode.commands.registerCommand(
        'platformio-ide.activeEnvironment',
        async () => await this._pool.getActiveObserver().revealActiveEnvironment(),
      ),
    ];
    this.internalSubscriptions = [];

    this.registerEnvSwitcher();
    // switch to the first project in a workspace on start-up
    this.switchToProject(this.findActiveProjectDir(), { force: true });
    
    // Initialize clangd support for the first project after a delay
    setTimeout(() => {
      this.rebuildClangdIndex();
    }, 2000);
  }

  async rebuildClangdIndex() {
    console.log('rebuildClangdIndex called');
    try {
      const observer = this._pool.getActiveObserver();
      if (!observer) {
        console.log('No active observer found');
        vscode.window.showErrorMessage('No active PlatformIO project found.');
        return;
      }
      console.log('Active project:', observer.projectDir);

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'PlatformIO: Initializing clangd and generating compile_commands.json',
          cancellable: true,
        },
        async (progress, token) => {
          progress.report({ message: 'Initializing project with clangd support...', increment: 0 });

          try {
            // Get the currently selected environment
            const selectedEnv = observer.getSelectedEnv();
            const envArgs = selectedEnv ? ['-e', selectedEnv] : [];
            
            console.log('Project directory:', observer.projectDir);
            console.log('Selected environment:', selectedEnv);
            console.log('Environment args:', envArgs);

            // Use background execution with proper PATH setup
            console.log('Running clangd setup in background...');
            
            const { spawn } = require('child_process');
            const { promisify } = require('util');
            const exec = promisify(require('child_process').exec);
            
            // Get PlatformIO Core path and add to PATH
            const pioCorePath = await pioNodeHelpers.core.getCoreDir();
            const platformioPath = path.join(pioCorePath, 'penv', 'bin');
            const platformioScriptsPath = path.join(pioCorePath, 'penv', 'Scripts');
            
            console.log('PlatformIO Core path:', pioCorePath);
            console.log('PlatformIO bin path:', platformioPath);
            
            // Create environment with PlatformIO in PATH
            const env = {
              ...process.env,
              PATH: `${platformioPath}${path.delimiter}${platformioScriptsPath}${path.delimiter}${process.env.PATH}`,
              PLATFORMIO_HOME_DIR: pioCorePath,
            };
            
            console.log('Running: pio init --ide clangd', envArgs);
            
            // Step 1: Run pio init --ide clangd
            const initProcess = spawn('pio', ['init', '--ide', 'clangd', ...envArgs], {
              cwd: observer.projectDir,
              env: env,
              stdio: ['pipe', 'pipe', 'pipe']
            });
            
            await new Promise((resolve, reject) => {
              let initOutput = '';
              let initError = '';
              
              initProcess.stdout.on('data', (data) => {
                initOutput += data.toString();
                console.log('Init stdout:', data.toString());
              });
              
              initProcess.stderr.on('data', (data) => {
                initError += data.toString();
                console.log('Init stderr:', data.toString());
              });
              
              initProcess.on('close', (code) => {
                console.log('Init process exited with code:', code);
                if (code === 0) {
                  resolve();
                } else {
                  reject(new Error(`pio init failed with code ${code}: ${initError}`));
                }
              });
            });
            
            progress.report({ message: 'Generating compilation database...', increment: 50 });
            
            console.log('Running: pio run -t compiledb', envArgs);
            
            // Step 2: Run pio run -t compiledb
            const compiledbProcess = spawn('pio', ['run', '-t', 'compiledb', ...envArgs], {
              cwd: observer.projectDir,
              env: env,
              stdio: ['pipe', 'pipe', 'pipe']
            });
            
            await new Promise((resolve, reject) => {
              let compiledbOutput = '';
              let compiledbError = '';
              
              compiledbProcess.stdout.on('data', (data) => {
                compiledbOutput += data.toString();
                console.log('Compiledb stdout:', data.toString());
              });
              
              compiledbProcess.stderr.on('data', (data) => {
                compiledbError += data.toString();
                console.log('Compiledb stderr:', data.toString());
              });
              
              compiledbProcess.on('close', (code) => {
                console.log('Compiledb process exited with code:', code);
                if (code === 0) {
                  resolve();
                } else {
                  reject(new Error(`pio run -t compiledb failed with code ${code}: ${compiledbError}`));
                }
              });
            });

            const fs = require('fs');
            const clangdPath = path.join(observer.projectDir, '.clangd');
            const compiledbPath = path.join(observer.projectDir, 'compile_commands.json');
            
            console.log('Checking for .clangd file:', clangdPath);
            console.log('Checking for compile_commands.json:', compiledbPath);
            
            const clangdExists = fs.existsSync(clangdPath);
            const compiledbExists = fs.existsSync(compiledbPath);
            
            console.log('.clangd exists:', clangdExists);
            console.log('compile_commands.json exists:', compiledbExists);
            
            if (!clangdExists || !compiledbExists) {
              console.log('Files still not found, showing terminal for manual execution...');
              vscode.window.showWarningMessage(
                'Clangd setup commands sent to terminal. Please check the terminal for any errors and run manually if needed.'
              );
            }

            progress.report({ message: 'Compilation database generated successfully!', increment: 100 });
            
            // Restart clangd server to pick up new compilation database
            console.log('Restarting clangd server...');
            try {
              // Try multiple clangd restart commands for different extensions
              await vscode.commands.executeCommand('clangd.restart');
              console.log('clangd.restart command executed successfully');
            } catch (err) {
              console.log('clangd.restart not available, trying alternative commands...');
              try {
                await vscode.commands.executeCommand('clangd.restartLanguageServer');
                console.log('clangd.restartLanguageServer command executed successfully');
              } catch (err2) {
                console.log('clangd.restartLanguageServer not available, trying clangd.reload...');
                try {
                  await vscode.commands.executeCommand('clangd.reload');
                  console.log('clangd.reload command executed successfully');
                } catch (err3) {
                  console.log('No clangd restart commands available');
                }
              }
            }

            vscode.window.showInformationMessage(
              `PlatformIO: Project initialized with clangd support and compile_commands.json generated${selectedEnv ? ` (env: ${selectedEnv})` : ''}. Clangd server restarted.`
            );
          } catch (err) {
            throw new Error(`Failed to initialize clangd support: ${err.message}`);
          }
        }
      );
    } catch (err) {
      console.error('rebuildClangdIndex error:', err);
      vscode.window.showErrorMessage(
        `Failed to initialize clangd support: ${err.message}`
      );
    }
  }

  dispose() {
    this.disposeInternals();
    disposeSubscriptions(this.internalSubscriptions);
    disposeSubscriptions(this.subscriptions);
  }

  findActiveProjectDir() {
    let projectDir = undefined;
    if (extension.getConfiguration('activateProjectOnTextEditorChange')) {
      projectDir = projectHelpers.getActiveEditorProjectDir();
    }
    return projectDir || this.getSelectedProjectDir();
  }

  getSelectedProjectDir() {
    const pioProjectDirs = projectHelpers.getPIOProjectDirs();
    const currentActiveDir = this._pool.getActiveProjectDir();
    if (pioProjectDirs.length < 1) {
      return undefined;
    }
    if (
      currentActiveDir &&
      pioProjectDirs.find((projectDir) => projectDir === currentActiveDir)
    ) {
      return currentActiveDir;
    }
    const lastActiveDir = projectHelpers.getLastProjectDir();
    if (
      lastActiveDir &&
      pioProjectDirs.find((projectDir) => projectDir === lastActiveDir)
    ) {
      return lastActiveDir;
    }
    return pioProjectDirs[0];
  }

  saveActiveProjectState() {
    const observer = this._pool.getActiveObserver();
    if (!observer) {
      return;
    }
    projectHelpers.updateProjectItemState(
      observer.projectDir,
      'selectedEnv',
      observer.getSelectedEnv(),
    );
  }

  async switchToProject(projectDir, options = {}) {
    if (!projectDir) {
      console.error('switchProject => Please provide project folder');
      return;
    }
    this._sbEnvSwitcher.text = '$(root-folder) Loading...';

    let currentProjectDir = undefined;
    let currentEnv = undefined;
    if (this._pool.getActiveObserver()) {
      currentProjectDir = this._pool.getActiveObserver().projectDir;
      currentEnv = this._pool.getActiveObserver().getSelectedEnv();
    }
    const observer = this._pool.getObserver(projectDir);

    // validate configuration file
    const configUri = vscode.Uri.file(path.join(projectDir, 'platformio.ini'));
    try {
      const isConfigValid = await this._configProvider.lintConfig(configUri);
      if (!isConfigValid) {
        vscode.window.showErrorMessage(
          'The project configuration process has encountered an error due to ' +
            "a problem with the 'platformio.ini' file. " +
            'Please review the file and fix the issues.',
        );
        vscode.window.showTextDocument(configUri);
        return;
      }
    } catch (err) {
      console.error(err);
    }

    if ('env' in options) {
      await observer.switchProjectEnv(options.env);
    } else if (!observer.getSelectedEnv()) {
      await observer.switchProjectEnv(
        projectHelpers.getProjectItemState(projectDir, 'selectedEnv'),
      );
    }

    // ignore active project and & env
    if (
      options.force ||
      !currentProjectDir ||
      currentProjectDir !== projectDir ||
      currentEnv !== observer.getSelectedEnv()
    ) {
      disposeSubscriptions(this.internalSubscriptions);
      await this._pool.switch(projectDir);
      this._taskManager = new ProjectTaskManager(projectDir, observer);
      this.internalSubscriptions.push(
        this._taskManager,
        new ProjectTestManager(projectDir),
      );

      // Always rebuild clangd index when environment changes to update toolchain paths
      // Small delay to ensure the environment switch is complete
      setTimeout(() => {
        this.rebuildClangdIndex();
      }, 1000);

      // open "platformio.ini" if no visible editors
      if (
        vscode.window.visibleTextEditors.length === 0 &&
        extension.getConfiguration('autoOpenPlatformIOIniFile')
      ) {
        vscode.window.showTextDocument(
          vscode.Uri.file(path.join(projectDir, 'platformio.ini')),
        );
      }
    }

    this.showSelectedEnv();
    this.saveActiveProjectState();
  }

  registerEnvSwitcher() {
    this._sbEnvSwitcher = vscode.window.createStatusBarItem(
      'pio-env-switcher',
      vscode.StatusBarAlignment.Left,
      STATUS_BAR_PRIORITY_START,
    );
    this._sbEnvSwitcher.name = 'PlatformIO: Project Environment Switcher';
    this._sbEnvSwitcher.tooltip = 'Switch PlatformIO Project Environment';
    this._sbEnvSwitcher.command = 'platformio-ide.pickProjectEnv';
    this._sbEnvSwitcher.text = '$(root-folder) Loading...';
    this._sbEnvSwitcher.show();

    this.subscriptions.push(
      this._sbEnvSwitcher,
      vscode.commands.registerCommand('platformio-ide.pickProjectEnv', () =>
        this.pickProjectEnv(),
      ),
    );
  }

  showSelectedEnv() {
    const observer = this._pool.getActiveObserver();
    if (!observer) {
      return;
    }
    const env = observer.getSelectedEnv()
      ? `env:${observer.getSelectedEnv()}`
      : 'Default';
    this._sbEnvSwitcher.text = `$(root-folder) ${env} (${path.basename(
      observer.projectDir,
    )})`;
  }

  async pickProjectEnv() {
    const items = [];
    for (const projectDir of projectHelpers.getPIOProjectDirs()) {
      const observer = this._pool.getObserver(projectDir);
      const envs = (await observer.getConfig()).envs();
      if (!envs || !envs.length) {
        continue;
      }
      const shortProjectDir = `${path.basename(
        path.dirname(projectDir),
      )}/${path.basename(projectDir)}`;
      items.push({
        projectDir,
        label: 'Default',
        description: `$(folder) ${shortProjectDir} ("default_envs" from "platformio.ini")`,
      });
      items.push(
        ...envs.map((env) => ({
          projectDir,
          env,
          label: `env:${env}`,
          description: `$(folder) ${shortProjectDir}`,
        })),
      );
    }
    const pickedItem = await vscode.window.showQuickPick(items, {
      matchOnDescription: true,
    });
    if (!pickedItem) {
      return;
    }
    this.switchToProject(pickedItem.projectDir, { env: pickedItem.env, force: true });
  }
}

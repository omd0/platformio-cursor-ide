/**
 * Copyright (c) 2017-present PlatformIO <contact@platformio.org>
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import { CONFLICTED_EXTENSION_IDS, REQUIRED_EXTENSION_IDS, CPP_TOOLCHAIN_EXTENSIONS } from './constants';
import { extension } from './main';
import vscode from 'vscode';

export async function maybeRateExtension() {
  const stateKey = 'rate-extension';
  const askAfterSessionNums = 13;
  let state = extension.context.globalState.get(stateKey);
  if (state && state.done) {
    return;
  } else if (!state || !state.callCounter) {
    state = {
      callCounter: 0,
      done: false,
    };
  }

  state.callCounter += 1;
  if (state.callCounter < askAfterSessionNums) {
    extension.context.globalState.update(stateKey, state);
    return;
  }

  const selectedItem = await vscode.window.showInformationMessage(
    'If you enjoy using PlatformIO IDE for VSCode, would you mind taking a moment to rate it? ' +
      'It will not take more than one minute. Thanks for your support!',
    { title: 'Rate PlatformIO IDE Extension', isCloseAffordance: false },
    { title: 'Remind later', isCloseAffordance: false },
    { title: 'No, Thanks', isCloseAffordance: true },
  );

  switch (selectedItem ? selectedItem.title : undefined) {
    case 'Rate PlatformIO IDE Extension':
      vscode.commands.executeCommand(
        'vscode.open',
        vscode.Uri.parse('http://bit.ly/pio-vscode-rate'),
      );
      state.done = true;
      break;
    case 'No, Thanks':
      state.done = true;
      break;
    default:
      state.callCounter = 0;
  }
  extension.context.globalState.update(stateKey, state);
}

export async function checkRequiredExtensions() {
  const missing = REQUIRED_EXTENSION_IDS.filter(
    (id) => !vscode.extensions.all.find((ext) => ext.id === id),
  );
  
  if (missing.length === 0) {
    return;
  }
  
  const selectedItem = await vscode.window.showWarningMessage(
    `Required extensions for the modern PlatformIO toolchain are missing (${missing.join(', ')}). ` +
      'These extensions are needed for IntelliSense, build system, and debugging functionality.',
    { title: 'Install missing extensions', isCloseAffordance: false },
    { title: 'More details', isCloseAffordance: false },
    { title: 'Remind later', isCloseAffordance: true },
  );
  
  switch (selectedItem ? selectedItem.title : undefined) {
    case 'Install missing extensions':
      for (const extensionId of missing) {
        await vscode.commands.executeCommand(
          'workbench.extensions.installExtension',
          extensionId,
        );
      }
      vscode.commands.executeCommand('workbench.action.reloadWindow');
      break;
    case 'More details':
      vscode.commands.executeCommand(
        'vscode.open',
        vscode.Uri.parse('https://docs.platformio.org/en/latest/integration/ide/vscode.html#modern-toolchain'),
      );
      break;
  }
}

export async function handleCppToolchainSetup(toolchain = 'ms-vscode.cpptools') {
  // Recommend appropriate extension
  const targetExtension = toolchain;
  const extension = vscode.extensions.getExtension(targetExtension);
  
  if (!extension) {
    const displayName = toolchain === 'anysphere.cpptools' ? 'anysphere C++ Tools' : 'Microsoft C/C++ Tools';
    const action = await vscode.window.showInformationMessage(
      `${displayName} extension is required for C++ IntelliSense. Install it?`,
      'Install', 'Later'
    );

    if (action === 'Install') {
      await vscode.commands.executeCommand(
        'workbench.extensions.installExtension', 
        targetExtension
      );
      vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
    return;
  }

  // Handle conflicting extensions - warn if multiple C++ extensions are active
  const activeCppExtensions = CPP_TOOLCHAIN_EXTENSIONS.filter(
    (id) => {
      const ext = vscode.extensions.getExtension(id);
      return ext && ext.isActive;
    }
  );

  if (activeCppExtensions.length > 1) {
    const conflictingExtensions = activeCppExtensions.filter(id => id !== toolchain);
    
    if (conflictingExtensions.length > 0) {
      const action = await vscode.window.showWarningMessage(
        `Multiple C++ extensions are active (${activeCppExtensions.join(', ')}). ` +
          `This may cause conflicts. Disable ${conflictingExtensions.join(', ')}?`,
        'Disable Others', 'Keep All'
      );

      if (action === 'Disable Others') {
        for (const conflictingId of conflictingExtensions) {
          await vscode.commands.executeCommand(
            'workbench.extensions.disableWorkspace', 
            conflictingId
          );
        }
        vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    }
  }
}

export async function warnAboutConflictedExtensions() {
  const conflicted = vscode.extensions.all.filter(
    (ext) => ext.isActive && CONFLICTED_EXTENSION_IDS.includes(ext.id),
  );
  if (conflicted.length === 0) {
    return;
  }
  const selectedItem = await vscode.window.showWarningMessage(
    `Conflicted extensions with the modern PlatformIO toolchain were detected (${conflicted
      .map((ext) => ext.packageJSON.displayName || ext.id)
      .join(', ')}). ` +
      'Code-completion, linting and navigation will not work properly. ' +
      'Please disable or uninstall them (Menu > View > Extensions).',
    { title: 'More details', isCloseAffordance: false },
    { title: 'Uninstall conflicted', isCloseAffordance: false },
    { title: 'Remind later', isCloseAffordance: true },
  );
  switch (selectedItem ? selectedItem.title : undefined) {
    case 'More details':
      vscode.commands.executeCommand(
        'vscode.open',
        vscode.Uri.parse('https://docs.platformio.org/en/latest/integration/ide/vscode.html#modern-toolchain'),
      );
      break;
    case 'Uninstall conflicted':
      conflicted.forEach((ext) => {
        vscode.commands.executeCommand(
          'workbench.extensions.uninstallExtension',
          ext.id,
        );
      });
      vscode.commands.executeCommand('workbench.action.reloadWindow');
      break;
  }
}

export async function warnAboutInoFile(editor) {
  if (!editor || !editor.document || !editor.document.fileName) {
    return;
  }
  if (!editor.document.fileName.endsWith('.ino')) {
    return;
  }
  const stateKey = 'ino-warn-disabled';
  if (extension.context.globalState.get(stateKey)) {
    return;
  }

  const selectedItem = await vscode.window.showWarningMessage(
    'The clangd language server does not support .INO files. ' +
      'It might lead to the spurious problems with code completion, linting, and debugging. ' +
      'Please convert .INO sketch into the valid .CPP file.',
    { title: 'Show instruction', isCloseAffordance: false },
    { title: 'Do not show again', isCloseAffordance: false },
    { title: 'Remind later', isCloseAffordance: true },
  );
  switch (selectedItem ? selectedItem.title : undefined) {
    case 'Show instruction':
      vscode.commands.executeCommand(
        'vscode.open',
        vscode.Uri.parse('https://bit.ly/convert-ino-to-cpp'),
      );
      break;
    case 'Do not show again':
      extension.context.globalState.update(stateKey, 1);
      break;
  }
}

// Import the required functions & object types from various packages.
import { Client } from 'discord-rpc';
import { basename, extname, parse, sep } from 'path';
import { setInterval, clearInterval } from 'timers';
import {
	commands,
	debug,
	Disposable,
	env,
	ExtensionContext,
	StatusBarItem,
	StatusBarAlignment,
	window,
	workspace,
	WorkspaceFolder
} from 'vscode';
import { statSync } from 'fs';
const lang = require('./data/languages.json');

interface FileDetail {
	size: string | null;
	totalLines: string | null;
	currentLine: string | null;
	currentColumn: string | null;
}

const knownExtentions: { [x: string]: { image: string } } = lang.knownExtentions;
const knownLanguages: string[] = lang.knownLanguages;

// Define the RPC variable and its type.
let rpc: Client;
// Define the config variable and its type.
let config;
// Define the reconnecting var and its type.
let reconnecting: boolean;
// Define the reconnect counter and its type.
let reconnectCounter = 0;
// Define the last known file and its type.
let lastKnownFile: string;
// Define the activity object.
let activity: object;
// Define the activity timer to not spam the API with requests.
let activityTimer: NodeJS.Timer;
// Define the status bar icon
let statusBarIcon: StatusBarItem;

// `Activate` is fired when the extension is enabled. This SHOULD only fire once.
export function activate(context: ExtensionContext) {
	console.log('[Discord Presence]: Activated!');
	// Get the workspace's configuration for "discord".
	config = workspace.getConfiguration('discord');

	// Obtain whether or not the extension is activated.
	if (config.get('enabled')) initRPC(config.get('clientID'));

	// Register the `discord.enable` command, and set the `enabled` config option to true.
	const enabler = commands.registerCommand('discord.enable', async () => {
		if (rpc) await destroyRPC();
		await config.update('enabled', true);
		config = workspace.getConfiguration('discord');
		initRPC(config.get('clientID'));
		window.showInformationMessage('Enabled Discord Rich Presence for this workspace.');
	});

	// Register the `discord.disable` command, and set the `enabled` config option to false.
	const disabler = commands.registerCommand('discord.disable', async () => {
		if (!rpc) return window.showWarningMessage('Discord Rich Presence is already disabled in this workspace.');
		await config.update('enabled', false);
		config = workspace.getConfiguration('discord');
		await destroyRPC();
		window.showInformationMessage('Disabled Discord Rich Presence for this workspace.');
	});

	// Register the `discord.reconnect` command
	const reconnecter = commands.registerCommand('discord.reconnect', async () => {
		if (rpc) try { await destroyRPC(); } catch {}
		initRPC(config.get('clientID'), true);

		if (!config.get('silent')) window.showInformationMessage('Reconnecting to Discord RPC');

		if (statusBarIcon) statusBarIcon.text = '$(pulse) Reconnecting';
	});

	// Push the new commands into the subscriptions.
	context.subscriptions.push(enabler, disabler, reconnecter);
}

// `Deactivate` is fired whenever the extension is deactivated.
export async function deactivate() {
	// If there's an RPC Client initalized, destroy it.
	await destroyRPC();
}

// Initalize the RPC systems.
function initRPC(clientID: string, loud?: boolean): void {
	// Update the RPC variable with a new RPC Client.
	rpc = new Client({ transport: 'ipc' });

	// Once the RPC Client is ready, set the activity.
	rpc.once('ready', () => {
		console.log('[Discord Presence]: Successfully connected to Discord');
		// Announce the reconnection
		if (loud && !config.get('silent')) window.showInformationMessage('Successfully reconnected to Discord RPC');

		// Remove icon if connected
		if (statusBarIcon) {
			statusBarIcon.dispose();
			statusBarIcon = null;
		}

		// Stop from reconnecing.
		reconnecting = false;
		// This is purely for safety measures.
		if (activityTimer) {
			// Clear the activity interval.
			clearInterval(activityTimer);
			// Null activity variable.
			activityTimer = null;
		}
		// Reset the reconnect counter to 0 on a successful reconnect.
		reconnectCounter = 0;
		setActivity();
		// Set the activity once on ready
		setTimeout(() => rpc.setActivity(activity).catch(err => console.error(`[Discord Presence]: ${err}`)), 500);
		// Make sure to listen to the close event and dispose and destroy everything accordingly.
		rpc.transport.once('close', async () => {
			if (!config.get('enabled')) return;
			await destroyRPC();

			// Set the client to begin reconnecting
			reconnecting = true;
			initRPC(config.get('clientID'));
			// Create reconnecting button
			createButton(true);
		});

		// Update the user's activity to the `activity` variable.
		activityTimer = setInterval(() => {
			// Update the config before updating the activity
			config = workspace.getConfiguration('discord');
			setActivity(Boolean(config.get('workspaceElapsedTime')));
			rpc.setActivity(activity).catch(err => console.error(`[Discord Presence]: ${err}`));
		}, 15000);
	});

	// Log in to the RPC Client, and check whether or not it errors.
	rpc.login({ clientId: clientID }).catch(async error => {
		// Check if the client is reconnecting
		console.error(`[Discord Presence]: ${error}`);
		if (reconnecting) {
			// Destroy and dispose of everything after the set reconnect attempts
			if (reconnectCounter >= config.get('reconnectThreshold')) {
				// Create reconnect button
				createButton();
				await destroyRPC();
			} else {
				// Increment the counter
				reconnectCounter++;
				// Create reconnecting button
				createButton(true);
				// Retry connection
				initRPC(config.get('clientID'));
				return;
			}
		}
		// Announce failure
		if (!config.get('silent')) {
			if (error.message.includes('ENOENT')) window.showErrorMessage('No Discord Client detected!');
			else window.showErrorMessage(`Couldn't connect to Discord via RPC: ${error.toString()}`);
			createButton();
		}
	});
}

// Create reconnect button
function createButton(isReconnecting?: boolean): void {
	// Check if the button exists already
	if (!statusBarIcon) {
		// Create the icon
		statusBarIcon = window.createStatusBarItem(StatusBarAlignment.Left);
		// Check if the client is reconnecting
		if (isReconnecting) {
			// Show attempts left
			const attempts = config.get('reconnectThreshold') - reconnectCounter;
			statusBarIcon.text = `$(issue-reopened) Reconnecting: ${attempts} attempt${attempts === 1 ? '' : 's'} left`;
			statusBarIcon.command = '';
		} else {
			// Show button to reconnect
			statusBarIcon.text = '$(plug) Reconnect to Discord';
			statusBarIcon.command = 'discord.reconnect';
		}
		// Show the button
		statusBarIcon.show();
	} else {
		// Check if the client is reconnecting
		if (isReconnecting) {
			// Show attempts left
			const attempts = config.get('reconnectThreshold') - reconnectCounter;
			statusBarIcon.text = `$(issue-reopened) Reconnecting: ${attempts} attempt${attempts === 1 ? '' : 's'} left`;
			statusBarIcon.command = '';
		} else {
			// Show button to reconnect
			statusBarIcon.text = '$(plug) Reconnect to Discord';
			statusBarIcon.command = 'discord.reconnect';
		}
	}
}

// Cleanly destroy the RPC client (if it isn't already) && add icon to reconnect
async function destroyRPC(): Promise<void> {
	// Do not continue if RPC isn't initalized.
	if (!rpc) return;
	// Stop reconnecting.
	reconnecting = false;
	// Clear the activity interval.
	if (activityTimer) clearInterval(activityTimer);
	// Null the activity timer.
	activityTimer = null;
	// If there's an RPC Client initalized, destroy it.
	await rpc.destroy();
	// Null the RPC variable.
	rpc = null;
	// Null the last known file.
	lastKnownFile = null;
}

// This function updates the activity (The Client's Rich Presence status).
function setActivity(workspaceElapsedTime: boolean = false): void {
	// Do not continue if RPC isn't initalized.
	if (!rpc) return;

	if (window.activeTextEditor && window.activeTextEditor.document.fileName === lastKnownFile) {
		activity = {
			...activity,
			details: generateDetails('detailsDebugging', 'detailsEditing', 'detailsIdle', this.largeImageKey),
			state: generateDetails('lowerDetailsDebugging', 'lowerDetailsEditing', 'lowerDetailsIdle', this.largeImageKey),
			smallImageKey: debug.activeDebugSession
				? 'debug'
				: env.appName.includes('Insiders')
				? 'vscode-insiders'
				: 'vscode',
		};
		return;
	}
	lastKnownFile = window.activeTextEditor ? window.activeTextEditor.document.fileName : null;

	const fileName: string = window.activeTextEditor ? basename(window.activeTextEditor.document.fileName) : null;
	const largeImageKey: any = window.activeTextEditor
		? knownExtentions[Object.keys(knownExtentions).find(key => {
			if (key.startsWith('.') && fileName.endsWith(key)) return true;
			const match = key.match(/^\/(.*)\/([mgiy]+)$/);
			if (!match) return false;
			const regex = new RegExp(match[1], match[2]);
			return regex.test(fileName);
		})] || (knownLanguages.includes(window.activeTextEditor.document.languageId) ? window.activeTextEditor.document.languageId : null)
		: 'vscode-big';

	// Get the previous activity start timestamp (if available) to preserve workspace elapsed time
	let previousTimestamp = null;
	if (activity) previousTimestamp = activity['startTimestamp'];
	// Create a JSON Object with the user's activity information.
	activity = {
		details: generateDetails('detailsDebugging', 'detailsEditing', 'detailsIdle', largeImageKey),
		state: generateDetails('lowerDetailsDebugging', 'lowerDetailsEditing', 'lowerDetailsIdle', largeImageKey),
		startTimestamp: window.activeTextEditor && previousTimestamp && workspaceElapsedTime ? previousTimestamp : window.activeTextEditor ? new Date().getTime() : null,
		largeImageKey: largeImageKey
			? largeImageKey.image
					|| largeImageKey
			: 'txt',
		largeImageText: window.activeTextEditor
			? config.get('largeImage').replace('{lang}', largeImageKey ? largeImageKey.image || largeImageKey : 'txt').replace('{LANG}', largeImageKey ? (largeImageKey.image || largeImageKey).toUpperCase() : 'TXT')
				|| window.activeTextEditor.document.languageId.padEnd(2, '\u200b')
			: config.get('largeImageIdle'),
		smallImageKey: debug.activeDebugSession
			? 'debug'
			: env.appName.includes('Insiders')
			? 'vscode-insiders'
			: 'vscode',
		smallImageText: config.get('smallImage').replace('{appname}', env.appName),
		instance: false
	};
}

function generateDetails(debugging, editing, idling, largeImageKey): string {
	const emptySpaces = '\u200b\u200b';
	let string: string = config.get(idling).replace('{null}', emptySpaces);

	const fileName: string = window.activeTextEditor ? basename(window.activeTextEditor.document.fileName) : null;
	let dirName: string = null;
	if (window.activeTextEditor) {
		const { dir } = parse(window.activeTextEditor.document.fileName);
		const split = dir.split(sep);
		dirName = split[split.length - 1];
	}
	const checkState: boolean = window.activeTextEditor
		? Boolean(workspace.getWorkspaceFolder(window.activeTextEditor.document.uri))
		: false;

	const workspaceFolder: WorkspaceFolder = checkState ? workspace.getWorkspaceFolder(window.activeTextEditor.document.uri) : null;

	let fullDirName: string = null;
	if (workspaceFolder) {
		const { name } = workspaceFolder;
		const relativePath = workspace.asRelativePath(window.activeTextEditor.document.fileName).split(sep);
		relativePath.splice(-1, 1);
		fullDirName = `${name}${sep}${relativePath.join(sep)}`;
	}

	if (window.activeTextEditor) {
		if (debug.activeDebugSession) {
			let rawString = config.get(debugging);
			const { totalLines, size, currentLine, currentColumn } = getFileDetails(rawString);
			rawString = rawString
				.replace('{null}', emptySpaces)
				.replace('{filename}', fileName)
				.replace('{dirname}', dirName)
				.replace('{fulldirname}', fullDirName)
				.replace('{workspace}',
					checkState ?
					workspaceFolder.name :
					config.get('lowerDetailsNotFound').replace('{null}', emptySpaces)
				)
				.replace('{lang}', largeImageKey ? largeImageKey.image || largeImageKey : 'txt')
				.replace('{LANG}', largeImageKey ? (largeImageKey.image || largeImageKey).toUpperCase() : 'TXT');
			if (totalLines) rawString = rawString.replace('{totallines}', totalLines);
			if (size) rawString = rawString.replace('{filesize}', size);
			if (currentLine) rawString = rawString.replace('{currentline}', currentLine);
			if (currentColumn) rawString = rawString.replace('{currentcolumn}', currentColumn);
			string = rawString;
		} else {
			let rawString = config.get(editing);
			const { totalLines, size, currentLine, currentColumn } = getFileDetails(rawString);
			rawString = rawString
				.replace('{null}', emptySpaces)
				.replace('{filename}', fileName)
				.replace('{dirname}', dirName)
				.replace('{fulldirname}', fullDirName)
				.replace('{workspace}',
					checkState ?
					workspaceFolder.name :
					config.get('lowerDetailsNotFound').replace('{null}', emptySpaces)
				)
				.replace('{lang}', largeImageKey ? largeImageKey.image || largeImageKey : 'txt')
				.replace('{LANG}', largeImageKey ? (largeImageKey.image || largeImageKey).toUpperCase() : 'TXT');
			if (totalLines) rawString = rawString.replace('{totallines}', totalLines);
			if (size) rawString = rawString.replace('{filesize}', size);
			if (currentLine) rawString = rawString.replace('{currentline}', currentLine);
			if (currentColumn) rawString = rawString.replace('{currentcolumn}', currentColumn);
			string = rawString;
		}
	}

	return string;
}

function getFileDetails(rawString): FileDetail {
	const obj = {
		size: null,
		totalLines: null,
		currentLine: null,
		currentColumn: null,
	};
	if (!rawString) return obj;
	if (rawString.includes('{totallines}')) {
		obj.totalLines = window.activeTextEditor.document.lineCount.toLocaleString();
	}
	if (rawString.includes('{currentline}')) {
		obj.currentLine = (window.activeTextEditor.selection.active.line + 1).toLocaleString();
	}
	if (rawString.includes('{currentcolumn}')) {
		obj.currentColumn = (window.activeTextEditor.selection.active.character + 1).toLocaleString();
	}
	if (rawString.includes('{filesize}')) {
		const sizes = [' bytes', 'kb', 'mb', 'gb', 'tb'];
		let currentDivision = 0;
		let { size } = statSync(window.activeTextEditor.document.fileName);
		const originalSize = size;
		if (originalSize > 1000) {
			size = size / 1000;
			currentDivision++;
			while (size > 1000) {
				currentDivision++;
				size = size / 1000;
			}
		}
		obj.size = `${originalSize > 1000 ? size.toFixed(2) : size}${sizes[currentDivision]}`;
	}
	return obj;
}

process.on('unhandledRejection', console.error);

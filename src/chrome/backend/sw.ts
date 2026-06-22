/*
 * backend/sw.js — Manifest V3 service-worker backend for wasavi + vim.wasm.
 *
 * The original wasavi backend is an MV2 *background page* built on the Kosian
 * framework, which relies on the DOM, localStorage and XMLHttpRequest and so
 * cannot run in an MV3 service worker. This file is a focused replacement that
 * implements exactly the message protocol the content-script agent
 * (frontend/agent.js) and the vim.wasm editor frame
 * (frontend/vimwasm_frame.js) need:
 *
 *   - init-agent : hand the content script its config (targets, shortcut, …)
 *   - init       : hand the editor frame its boot payload (the field's text)
 *   - push-payload : remember the boot payload the agent produced on activation
 *   - transfer   : relay messages between the agent and the editor frame
 *   - get/set-storage, get/set-clipboard : small services
 *
 * Routing model: the agent (content script) and the editor frame (an
 * extension-origin iframe) live in the SAME browser tab. The agent is reached
 * with chrome.tabs.sendMessage() (it filters by wasavi's internal frameId);
 * the extension iframe is reached with a chrome.runtime broadcast.
 */
'use strict';

// --------------------------------------------------------------------------
// configuration (defaults mirror the original backend's config defaults)
// --------------------------------------------------------------------------
const DEFAULT_FONT = '"Consolas","Monaco","Courier New","Courier",monospace';
const DEFAULT_HOTKEYS = '<insert>,<c-enter>';
const STATUS_LINE_HEIGHT = 16;

const DEFAULT_TARGETS = {
	enableTextArea:        true,
	enableText:            false,
	enableSearch:          false,
	enableTel:             false,
	enableUrl:             false,
	enableEmail:           false,
	enablePassword:        false,
	enableNumber:          false,
	enableContentEditable: true,
	enablePage:            false
};

// subset of Kosian's Hotkey keyTable, enough for the default + common keys
const KEY_TABLE: { [name: string]: number } = {
	enter: 13, return: 13, ret: 13, insert: 45, ins: 45, esc: 27, escape: 27,
	space: 32, tab: 9, backspace: 8, bs: 8, delete: 46, del: 46,
	f1: 112, f2: 113, f3: 114, f4: 115, f5: 116, f6: 117,
	f7: 118, f8: 119, f9: 120, f10: 121, f11: 122, f12: 123
};
// letters a-z and digits 0-9 (keydown keyCode is the uppercase/base code)
for (let i = 0; i < 26; i++) KEY_TABLE[String.fromCharCode(97 + i)] = 65 + i;
for (let i = 0; i <= 9; i++) KEY_TABLE[String(i)] = 48 + i;

// reverse lookup: keyCode -> first descriptor name (for query-shortcut capture)
function keyNameFromCode(code: number): string | null {
	for (const name of Object.keys(KEY_TABLE)) {
		if (KEY_TABLE[name] === code) return name;
	}
	return null;
}

// Reproduces Kosian Hotkey#parseHotkeys (DOM variant): "<c-enter>,<insert>"
// -> [{keyCode, shiftKey, ctrlKey}, ...]
function parseHotkeys (desc) {
	const result = [];
	(desc || DEFAULT_HOTKEYS).toLowerCase().split(/\s*,\s*/).forEach(sc => {
		const m = /^<([^>]+)>$/.exec(sc);
		if (!m) return;
		const mods = m[1].split('-');
		const key = mods.pop();
		if (!(key in KEY_TABLE)) return;
		const code = {keyCode: KEY_TABLE[key], shiftKey: false, ctrlKey: false};
		mods.forEach(mod => {
			if (mod === 's') code.shiftKey = true;
			if (mod === 'c') code.ctrlKey = true;
		});
		result.push(code);
	});
	return result.length ? result : parseHotkeys(DEFAULT_HOTKEYS);
}

let configCache = null;
function loadConfig () {
	if (configCache) return Promise.resolve(configCache);
	return new Promise(resolve => {
		chrome.storage.sync.get({
			targets: DEFAULT_TARGETS,
			shortcut: DEFAULT_HOTKEYS,
			fontFamily: DEFAULT_FONT,
			quickActivation: false,
			siteOverrides: false,
			logMode: false
		}, items => {
			void chrome.runtime.lastError;
			configCache = {
				targets: items.targets || DEFAULT_TARGETS,
				shortcut: items.shortcut || DEFAULT_HOTKEYS,
				shortcutCode: parseHotkeys(items.shortcut || DEFAULT_HOTKEYS),
				fontFamily: items.fontFamily || DEFAULT_FONT,
				quickActivation: !!items.quickActivation,
				siteOverrides: items.siteOverrides || false,
				logMode: !!items.logMode
			};
			resolve(configCache);
		});
	});
}

// --------------------------------------------------------------------------
// pending boot payload (single in-flight activation, like the original)
// --------------------------------------------------------------------------
let pendingPayload = null;

function setPendingPayload (p) {
	pendingPayload = p;
	try { chrome.storage.session.set({pendingPayload: p}); } catch (e) {}
}

// Resolve the boot payload, tolerating the race where the frame's "init"
// arrives slightly before the agent's "push-payload".
function waitForPayload (timeoutMS) {
	const deadline = Date.now() + (timeoutMS || 2000);
	return new Promise(resolve => {
		(function poll () {
			if (pendingPayload) return resolve(pendingPayload);
			if (Date.now() >= deadline) {
				// last resort: a payload persisted before a worker restart
				try {
					chrome.storage.session.get('pendingPayload', items => {
						resolve((items && items.pendingPayload) || null);
					});
				} catch (e) { resolve(null); }
				return;
			}
			setTimeout(poll, 50);
		})();
	});
}

// --------------------------------------------------------------------------
// message dispatch
// --------------------------------------------------------------------------
function isFromExtensionPage (sender) {
	return !!(sender && sender.url && sender.url.startsWith('chrome-extension://'));
}

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
	if (!req || !req.type) return;
	const tabId = sender && sender.tab ? sender.tab.id : null;
	const data = req.data || {};

	switch (req.type) {
	// content-script agent asks for its configuration
	case 'init-agent':
		loadConfig().then(cfg => {
			sendResponse(Object.assign({
				tabId: tabId,
				extensionId: chrome.runtime.id,
				version: chrome.runtime.getManifest().version,
				devMode: false,
				statusLineHeight: STATUS_LINE_HEIGHT
			}, cfg));
		});
		return true;

	// editor frame asks for its boot payload (contains the field text)
	case 'init':
		waitForPayload(2000).then(payload => {
			sendResponse({
				tabId: tabId,
				extensionId: chrome.runtime.id,
				fontFamily: (configCache && configCache.fontFamily) || DEFAULT_FONT,
				payload: payload || null
			});
		});
		return true;

	// options page (best effort; not required for editing)
	case 'init-options':
		loadConfig().then(cfg => sendResponse(Object.assign({
			tabId: tabId,
			exrc: '" exrc for wasavi',
			upgradeNotify: false,
			// options-core.js does req.fstab.filter(...); the online file systems
			// aren't wired up to the MV3 worker, so expose just the local one.
			fstab: [{name: 'file', isDefault: true, enabled: true}]
		}, cfg)));
		return true;

	// agent published the activation payload
	case 'push-payload':
		setPendingPayload(data);
		sendResponse({type: 'push-payload-response'});
		return false;

	// relay between agent (content script) and editor frame (extension iframe)
	case 'transfer': {
		const to = data.to;
		const payload = data.payload;
		const fromFrame = !!(sender && sender.url && sender.url.indexOf('wasavi.html') >= 0);
		if (fromFrame) {
			// frame -> agent. On an ordinary web page the agent is a content
			// script (reach via tabs.sendMessage). On an extension page (the
			// options page hosts the agent as a page script) it's only reachable
			// by a runtime broadcast.
			const hostIsExtensionPage = !!(sender && sender.tab && sender.tab.url &&
				sender.tab.url.indexOf('chrome-extension://') === 0);
			if (hostIsExtensionPage) {
				chrome.runtime.sendMessage(payload, res => { void chrome.runtime.lastError; sendResponse(res); });
			} else {
				chrome.tabs.sendMessage(to, payload, res => { void chrome.runtime.lastError; sendResponse(res); });
			}
		} else {
			// agent -> frame: the editor frame is always an extension page -> broadcast
			chrome.runtime.sendMessage(payload, res => { void chrome.runtime.lastError; sendResponse(res); });
		}
		return true;
	}

	case 'get-storage':
		chrome.storage.sync.get(data.key, items => {
			void chrome.runtime.lastError;
			sendResponse({key: data.key, value: items ? items[data.key] : undefined});
		});
		return true;

	// Persist config (options page Save). Config lives in chrome.storage.sync;
	// accepts either {key,value} or {items:[{key,value}, ...]}.
	case 'set-storage': {
		let items: Array<{key: string; value: any}> = [];
		if (Array.isArray(data.items)) items = data.items;
		else if ('key' in data && 'value' in data) items = [{key: data.key, value: data.value}];

		const toStore: { [k: string]: any } = {};
		for (const it of items) {
			if (it && 'key' in it && 'value' in it) toStore[it.key] = it.value;
		}

		chrome.storage.sync.set(toStore, () => {
			void chrome.runtime.lastError;
			configCache = null; // force reload (recomputes shortcutCode)

			// Push live updates to already-running agents so the new shortcut
			// takes effect without reloading the page.
			const live: { [k: string]: any } = {};
			if ('targets' in toStore) live.targets = toStore.targets;
			if ('quickActivation' in toStore) live.quickActivation = toStore.quickActivation;
			if ('logMode' in toStore) live.logMode = toStore.logMode;
			if ('siteOverrides' in toStore) live.siteOverrides = toStore.siteOverrides;
			if ('shortcut' in toStore) live.shortcutCode = parseHotkeys(toStore.shortcut);
			if (Object.keys(live).length > 0) {
				chrome.tabs.query({}, tabs => {
					for (const t of tabs) {
						if (t.id != null) {
							chrome.tabs.sendMessage(t.id, {type: 'update-storage', items: live},
								() => void chrome.runtime.lastError);
						}
					}
				});
			}
			sendResponse({ok: true});
		});
		return true;
	}

	// Build a hotkey descriptor (e.g. "<c-enter>") from a captured keypress.
	case 'query-shortcut': {
		const ev = (data && data.data) || data || {};
		const name = keyNameFromCode(ev.keyCode);
		if (!name) { sendResponse({result: ''}); return false; }
		let desc = '<';
		if (ev.ctrlKey) desc += 'c-';
		if (ev.shiftKey) desc += 's-';
		desc += name + '>';
		sendResponse({result: desc});
		return false;
	}

	case 'reset-options':
		chrome.storage.sync.clear(() => {
			void chrome.runtime.lastError;
			configCache = null;
			sendResponse({ok: true});
		});
		return true;

	// vim.wasm handles its own clipboard via navigator.clipboard in the frame;
	// these remain as harmless no-ops for any other caller.
	case 'get-clipboard':
		sendResponse({data: ''});
		return false;

	case 'set-clipboard':
		sendResponse({});
		return false;

	case 'ping':
		sendResponse({type: 'pong'});
		return false;
	}
});

// keep config fresh if the user changes options
chrome.storage.onChanged.addListener((changes, area) => {
	if (area === 'sync') configCache = null;
});

#!/usr/bin/env node
/*
 * Unit test for backend/sw.js — the MV3 service-worker backend.
 *
 * Chrome 137+ disables the --load-extension command-line switch, so the
 * unpacked extension cannot be auto-loaded for an in-browser end-to-end run in
 * this environment (the manifest itself is valid — it packs to a .crx).
 * Instead we load sw.js with a mocked `chrome` API and drive the exact
 * messages the content-script agent and the vim.wasm editor frame send,
 * asserting the routing and handshake behaviour.
 *
 * Run: node test-harness/sw.test.js
 */
import fs from 'node:fs';
import assert from 'node:assert';

const SW_PATH = new URL('../src/chrome/backend/sw.js', import.meta.url);
const code = fs.readFileSync(SW_PATH, 'utf8');

// ---- mock chrome API -----------------------------------------------------
let messageListener = null;
let lastError = undefined;
const storageLocal: any = {};
const storageSync: any = {};
const storageSession: any = {};
const tabsSent = [];
const runtimeSent = [];

const chrome = {
	runtime: {
		id: 'testextid',
		get lastError() { return lastError; },
		getManifest: () => ({version: '0.0.1'}),
		getURL: p => 'chrome-extension://testextid/' + p,
		onMessage: {addListener: fn => { messageListener = fn; }},
		// agent -> frame broadcast
		sendMessage: (payload, cb) => { runtimeSent.push(payload); if (cb) setTimeout(() => cb({broadcastAck: true}), 0); },
	},
	storage: {
		sync: {
				get: (defaults, cb) => {
					if (typeof defaults === 'string') { cb({[defaults]: storageSync[defaults]}); return; }
					const out = Object.assign({}, defaults);
					for (const k of Object.keys(out)) if (k in storageSync) out[k] = storageSync[k];
					cb(out);
				},
				set: (obj, cb) => { Object.assign(storageSync, obj); cb && cb(); },
				clear: (cb) => { for (const k of Object.keys(storageSync)) delete storageSync[k]; cb && cb(); },
			},
		local: {
			get: (key, cb) => cb({[key]: storageLocal[key]}),
			set: (obj, cb) => { Object.assign(storageLocal, obj); cb && cb(); },
		},
		session: {
			set: (obj, cb) => { Object.assign(storageSession, obj); cb && cb(); },
			get: (key, cb) => cb({[key]: storageSession[key]}),
		},
		onChanged: {addListener: () => {}},
	},
	tabs: {
		// frame -> agent: simulate the agent replying to the relayed payload
		sendMessage: (tabId, payload, cb) => {
			tabsSent.push({tabId, payload});
			if (cb) setTimeout(() => cb({relayedTo: tabId, echo: payload.type}), 0);
		},
		query: (_q, cb) => cb([{id: 42}]),
	},
};

// ---- load sw.js in a sandbox with the mock ------------------------------
new Function('chrome', 'setTimeout', code)(chrome, setTimeout);
assert(typeof messageListener === 'function', 'sw.js must register a runtime.onMessage listener');

// helper: dispatch a message and resolve with the sendResponse value
function send(req: any, sender: any): Promise<any> {
	return new Promise<any>(resolve => {
		let done = false;
		const sendResponse = (r?: any) => { if (!done) { done = true; resolve(r); } };
		const ret = messageListener(req, sender, sendResponse);
		if (ret !== true && !done) resolve(undefined);
	});
}

const AGENT = {tab: {id: 42}, url: 'http://localhost:8765/page.html', frameId: 0};
const FRAME = {tab: {id: 42}, url: 'chrome-extension://testextid/wasavi.html', frameId: 7};

(async () => {
	// 1. agent init-agent -> config
	const cfg = await send({type: 'init-agent', data: {url: AGENT.url}}, AGENT);
	assert.strictEqual(cfg.tabId, 42, 'init-agent returns sender tabId');
	assert.strictEqual(cfg.targets.enableTextArea, true, 'textarea editing enabled');
	assert.strictEqual(cfg.statusLineHeight, 16, 'statusLineHeight provided');
	assert(/Consolas/.test(cfg.fontFamily), 'default font provided');
	const hasCtrlEnter = cfg.shortcutCode.some(c => c.keyCode === 13 && c.ctrlKey === true && c.shiftKey === false);
	const hasInsert = cfg.shortcutCode.some(c => c.keyCode === 45);
	assert(hasCtrlEnter, 'shortcutCode includes Ctrl+Enter');
	assert(hasInsert, 'shortcutCode includes Insert');
	console.log('✓ init-agent returns valid config (targets, shortcut, font, statusLineHeight)');

	// 2. agent push-payload (the activation payload with the field text)
	const payload = {value: 'hello world', frameId: 0, parentTabId: 42, id: 'ta', nodeName: 'TEXTAREA', readOnly: false};
	await send({type: 'push-payload', data: payload}, AGENT);
	console.log('✓ push-payload accepted');

	// 3. frame init -> receives the stored boot payload
	const init = await send({type: 'init', data: {url: FRAME.url}}, FRAME);
	assert.strictEqual(init.tabId, 42, 'frame init returns tabId');
	assert(init.payload, 'frame init returns a payload');
	assert.strictEqual(init.payload.value, 'hello world', 'payload carries the field text');
	assert.strictEqual(init.payload.frameId, 0, 'payload carries wasavi frameId');
	assert(/Consolas/.test(init.fontFamily), 'frame init returns font');
	console.log('✓ frame init returns the boot payload with the field text');

	// 4. frame -> agent transfer (e.g. the :w write-back) is relayed via tabs.sendMessage
	const writeResp = await send(
		{type: 'transfer', data: {to: 42, payload: {type: 'write', value: 'HELLO world', frameId: 0}}},
		FRAME);
	assert.strictEqual(tabsSent.length, 1, 'frame->agent uses tabs.sendMessage');
	assert.strictEqual(tabsSent[0].tabId, 42, 'relayed to the agent tab');
	assert.strictEqual(tabsSent[0].payload.type, 'write', 'relayed the write payload');
	assert.strictEqual(tabsSent[0].payload.value, 'HELLO world', 'relayed the edited text');
	assert(writeResp && writeResp.echo === 'write', 'agent response relayed back to the frame');
	console.log('✓ frame->agent transfer (write-back) routed to content script + response relayed');

	// 5. agent -> frame transfer is broadcast via runtime.sendMessage
	await send({type: 'transfer', data: {to: 42, payload: {type: 'focus-me'}}}, AGENT);
	assert.strictEqual(runtimeSent.length, 1, 'agent->frame uses runtime broadcast');
	assert.strictEqual(runtimeSent[0].type, 'focus-me', 'broadcast carried the payload');
	console.log('✓ agent->frame transfer routed via runtime broadcast');

	// 6. storage round-trip
	await send({type: 'set-storage', data: {key: 'k', value: {a: 1}}}, AGENT);
	const got = await send({type: 'get-storage', data: {key: 'k'}}, AGENT);
	assert.deepStrictEqual(got.value, {a: 1}, 'storage get/set round-trips');
	console.log('✓ get/set-storage round-trips');

	// 7. terminated relay (frame -> agent), no value (discard semantics)
	tabsSent.length = 0;
	await send({type: 'transfer', data: {to: 42, payload: {type: 'terminated', isImplicit: false}}}, FRAME);
	assert.strictEqual(tabsSent[0].payload.type, 'terminated', 'terminated relayed to agent');
	console.log('✓ terminated relayed to agent');

	// 8. options Save: set-storage {items:[...]} persists the new shortcut to sync,
	//    and broadcasts an update-storage with the recomputed shortcutCode.
	tabsSent.length = 0;
	const saveResp = await send({type: 'set-storage', data: {items: [
		{key: 'shortcut', value: '<c-a>'},
		{key: 'quickActivation', value: true},
	]}}, AGENT);
	assert(saveResp && saveResp.ok, 'set-storage responds (Save indicator works)');
	assert.strictEqual(storageSync.shortcut, '<c-a>', 'shortcut persisted to sync storage');
	const upd = tabsSent.find(m => m.payload && m.payload.type === 'update-storage');
	assert(upd, 'update-storage broadcast to running agents');
	assert(upd.payload.items.shortcutCode.some((c: any) => c.keyCode === 65 && c.ctrlKey === true),
		'broadcast recomputed shortcutCode for <c-a>');
	assert.strictEqual(upd.payload.items.quickActivation, true, 'quickActivation broadcast');
	// next init-agent reflects the saved shortcut
	const cfg2 = await send({type: 'init-agent', data: {url: AGENT.url}}, AGENT);
	assert(cfg2.shortcutCode.some((c: any) => c.keyCode === 65 && c.ctrlKey === true),
		'reloaded config has the new shortcut');
	console.log('✓ options Save persists shortcut + live-broadcasts to agents');

	// 9. query-shortcut builds a descriptor from a captured keypress
	const q = await send({type: 'query-shortcut', data: {data: {ctrlKey: true, shiftKey: false, keyCode: 13}}}, AGENT);
	assert.strictEqual(q.result, '<c-enter>', 'query-shortcut builds <c-enter>');
	console.log('✓ query-shortcut builds hotkey descriptor');

	console.log('\nALL SERVICE-WORKER ROUTING TESTS PASSED');
})().catch(e => { console.error('\nTEST FAILED:', e.message); process.exit(1); });

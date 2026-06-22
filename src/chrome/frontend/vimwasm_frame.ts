// ==========================================================================
// vimwasm_frame.js
//
// Glue that runs inside the wasavi editor iframe and drives the vim.wasm
// WebAssembly build of vim in place of wasavi's own JavaScript vi engine.
//
// It speaks exactly the same message protocol to the page agent
// (frontend/agent.js) that the original engine (frontend/wasavi.js) used, so
// the agent and the background page need no changes:
//
//   agent                         this frame (vim.wasm)
//     | --- push-payload (value) --->|   (routed through the background page)
//     |                              |   connect('init') -> gets the payload
//     | <------ 'initialized' -------|
//     | <------ 'window-state' ------|   (maximize the iframe)
//     | <------ 'ready' -------------|   (agent reveals + focuses the frame)
//     |                              |
//     | <------ 'write' (value) -----|   on :w   (BufWritePost -> :export)
//     | <------ 'terminated' --------|   on :q / :wq / :qa
//
// The textarea content arrives in payload.value; we preload it as a file in
// vim's in-memory filesystem and open it.  An autocommand exports the file on
// every successful write, which is delivered back to the agent as a 'write'
// message and applied to the host element.  Quitting vim sends 'terminated',
// which makes the agent tear the iframe down.
// ==========================================================================

import {VimWasm, checkBrowserCompatibility} from './vim-wasm/vimwasm.js';

// The content-script messaging wrapper is loaded as a separate classic script
// (frontend/extension_wrapper.js) and exposed on the global object.
declare const WasaviExtensionWrapper: any;

(function () {
	'use strict';

	// path of the buffer file inside vim's MEMFS
	var HOME = '/home/web_user';

	var channel = null;        // WasaviExtensionWrapper instance
	var boot = null;           // boot payload from the agent (the "targetElement")
	var vim = null;            // VimWasm instance
	var filePath = '';         // path of the buffer file in MEMFS
	var terminated = false;
	var fullscreen = false;    // false = render over the text field; true = maximize

	function $ (id: string): any {
		return document.getElementById(id);
	}

	function resourceURL (path: string) {
		try {
			if (window.chrome && chrome.runtime && chrome.runtime.getURL) {
				return chrome.runtime.getURL(path);
			}
		}
		catch (e) {}
		return path;
	}

	// ----------------------------------------------------------------------
	// messaging toward the agent (mirror of wasavi.js#notifyToParent)
	// ----------------------------------------------------------------------
	function notifyToParent (eventName: string, payload?: any, callback?: any) {
		if (!channel || channel.isTopFrame()) return false;

		payload = payload || {};
		payload.type = eventName;
		payload.frameId = boot.frameId;

		channel.postMessage({
			type: 'transfer',
			to: boot.parentTabId,
			payload: payload
		}, callback);

		return true;
	}

	// ----------------------------------------------------------------------
	// UI helpers
	// ----------------------------------------------------------------------
	function showMessage (titleHTML, bodyHTML) {
		var el = $('wasavi_message');
		el.innerHTML = '<h1>' + titleHTML + '</h1>' + (bodyHTML || '');
		el.classList.add('visible');
	}

	function sanitizeName (s) {
		s = (s || '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^_+|_+$/g, '');
		return s || 'buffer';
	}

	// Wait until the iframe has been resized by the agent (after we request
	// a maximize), so vim.wasm reads a sensible initial screen size.  Falls
	// back to a timeout for the rare case where no resize is necessary.
	function waitForViewport (timeoutMS: number) {
		return new Promise<void>(function (resolve) {
			var done = false;
			function finish () {
				if (done) return;
				done = true;
				window.removeEventListener('resize', finish, false);
				resolve();
			}
			window.addEventListener('resize', finish, false);
			setTimeout(finish, timeoutMS);
		});
	}

	// ----------------------------------------------------------------------
	// boot
	// ----------------------------------------------------------------------
	function onConnect (req) {
		if (!req) return;

		// the wrapper does not assign tabId from the init response itself;
		// wasavi.js does this in install(). mirror it here.
		channel.tabId = req.tabId;
		fullscreen = !!req.fullscreen;
		channel.setMessageListener(handleBackendMessage);

		if (channel.isTopFrame()) {
			// "app mode": opened directly as a top level extension page.
			// there is no host element; just run vim on an empty buffer.
			boot = {
				frameId: 0,
				parentTabId: null,
				value: '',
				elementType: 'textarea',
				id: 'wasavi',
				readOnly: false
			};
		}
		else if (req.payload) {
			boot = req.payload;
		}
		else {
			return;
		}

		channel.ensureRun(start);
	}

	function start () {
		// 1. let the agent register us. The agent already sized the iframe over
		//    the target element; only grow it to full screen when configured.
		notifyToParent('initialized', {
			height: window.innerHeight,
			childTabId: channel.tabId
		});
		if (fullscreen) {
			notifyToParent('window-state', {state: 'maximized'});
		}

		// 2. refuse early if the platform cannot run vim.wasm.
		var incompatible = checkBrowserCompatibility();
		if (incompatible) {
			showIncompatible(incompatible);
			return;
		}

		// 3. start vim once the iframe has settled at its final size (a resize
		//    arrives when maximizing; otherwise this falls through on timeout).
		waitForViewport(fullscreen ? 400 : 50).then(startVim).catch(function (err) {
			showError(err);
		});
	}

	function showIncompatible (reason) {
		showMessage(
			'wasavi (vim.wasm) cannot start',
			reason + '\n\n' +
			'vim.wasm relies on <code>SharedArrayBuffer</code>, which a document\n' +
			'can only use when it is <code>crossOriginIsolated</code> (served with\n' +
			'<code>COOP: same-origin</code> + <code>COEP: require-corp</code>).\n\n' +
			'An iframe injected into an ordinary page does not meet that\n' +
			'requirement, so editing works only on cross-origin-isolated hosts\n' +
			'(see the bundled test harness).\n\n' +
			'Press <code>Esc</code> to close.');
		// make the message visible through the agent and let the user dismiss it.
		notifyToParent('ready');
		vim && vim.focus && vim.focus();
		$('wasavi_input').focus();
		window.addEventListener('keydown', function (e) {
			if (e.key === 'Escape' || (e.ctrlKey && e.key === 'c')) {
				terminate(1);
			}
		}, false);
	}

	function startVim () {
		var name = sanitizeName(boot.id || boot.nodeName || 'buffer') + '.txt';
		filePath = HOME + '/' + name;

		var files = {};
		files[filePath] = typeof boot.value === 'string' ? boot.value : '';

		vim = new VimWasm({
			canvas: $('wasavi_screen'),
			input: $('wasavi_input'),
			workerScriptPath: resourceURL('frontend/vim-wasm/vim.js')
		});

		vim.onVimInit = onVimInit;
		vim.onVimExit = onVimExit;
		vim.onFileExport = onFileExport;
		vim.onError = showError;
		vim.onTitleUpdate = function (title) { document.title = title; };
		if (navigator.clipboard) {
			vim.readClipboard = function () { return navigator.clipboard.readText(); };
			vim.onWriteClipboard = function (text) { navigator.clipboard.writeText(text); };
		}

		// Export the buffer on every successful write so the host element is
		// kept in sync, exactly like ":w" in the original engine.
		var autocmd =
			"autocmd BufWritePost * silent! execute 'export ' . fnameescape(expand('%:p'))";

		var cmdArgs = ['-n', '-c', autocmd];
		if (boot.readOnly) cmdArgs.push('-R');
		cmdArgs.push(filePath);

		// NOTE: do not pass dirs:[HOME] - /home/web_user already exists in the
		// vim.data image, and FS.mkdir() on it throws ("FS error").
		vim.start({
			clipboard: !!navigator.clipboard,
			files: files,
			cmdArgs: cmdArgs
		});
	}

	function onVimInit () {
		notifyToParent('ready');
		vim.focus();
		$('wasavi_input').focus();
	}

	function onFileExport (fullpath, contents) {
		var text = new TextDecoder('utf-8').decode(new Uint8Array(contents));
		notifyToParent('write', {
			value: text,
			path: '',
			isForce: true,
			isBuffered: false,
			writeAs: ''
		});
	}

	function onVimExit (status) {
		terminate(status);
	}

	function terminate (status) {
		if (terminated) return;
		terminated = true;
		notifyToParent('terminated', {
			isImplicit: false,
			isSubmitRequested: false,
			marks: null
		});
	}

	function showError (err) {
		var message = err && err.message ? err.message : String(err);
		showMessage('wasavi (vim.wasm) error', message);
		notifyToParent('ready');
	}

	// ----------------------------------------------------------------------
	// messages coming back from the background page / agent
	// ----------------------------------------------------------------------
	function handleBackendMessage (req) {
		if (!req || !req.type) return;
		switch (req.type) {
		case 'ping':
			break;
		// other agent->frame messages (focus-me responses etc.) arrive as
		// sendMessage responses, not as broadcasts, so nothing to do here.
		}
	}

	// ----------------------------------------------------------------------
	// bootstrap
	// ----------------------------------------------------------------------
	if (typeof WasaviExtensionWrapper !== 'undefined') {
		channel = WasaviExtensionWrapper.create();
		if (channel.urlInfo.isAny) {
			channel.connect('init', onConnect);
		}
	}
	else {
		showMessage(
			'wasavi (vim.wasm) cannot start',
			'WasaviExtensionWrapper is not available in this context.');
	}
})();

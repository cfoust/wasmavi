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
	var exrc = '';             // startup Vimscript (vimrc), from the options page

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
		exrc = typeof req.exrc === 'string' ? req.exrc : '';
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

	// ----------------------------------------------------------------------
	// system clipboard ("+/"* registers)
	//
	// The async Clipboard API is gated by Permissions Policy; on hosts that
	// disable clipboard-read/-write for this (cross-origin extension) frame the
	// promise rejects. Writes fall back to the legacy synchronous execCommand,
	// which is not Permissions-Policy gated and is permitted by the extension's
	// clipboardWrite permission. Reads have no such fallback (execCommand
	// 'paste' is blocked in content), so a blocked read resolves to '' and the
	// "+ register simply comes back empty rather than throwing.
	// ----------------------------------------------------------------------
	function writeClipboard (text: string): Promise<void> {
		var nav: any = navigator;
		if (nav.clipboard && nav.clipboard.writeText) {
			return nav.clipboard.writeText(text).catch(function () {
				execCopy(text);
			});
		}
		execCopy(text);
		return Promise.resolve();
	}

	function readClipboard (): Promise<string> {
		var nav: any = navigator;
		if (nav.clipboard && nav.clipboard.readText) {
			return nav.clipboard.readText().catch(function () { return ''; });
		}
		return Promise.resolve('');
	}

	// Legacy copy via a throwaway textarea + execCommand('copy'). Synchronous
	// and exempt from the async-clipboard Permissions Policy.
	function execCopy (text: string) {
		try {
			var ta = document.createElement('textarea');
			ta.value = text;
			ta.style.position = 'fixed';
			ta.style.opacity = '0';
			document.body.appendChild(ta);
			ta.focus();
			ta.select();
			document.execCommand('copy');
			document.body.removeChild(ta);
			// restore focus to the editor input
			$('wasavi_input').focus();
		}
		catch (e) {}
	}

	function startVim () {
		// Prefer a filename the agent derived from the editor (e.g. main.py from a
		// Monaco data-uri or data-mode-id) so Vim detects the filetype; otherwise
		// fall back to a generic .txt name.
		var name = boot.fileName ?
			sanitizeName(boot.fileName) :
			(sanitizeName(boot.id || boot.nodeName || 'buffer') + '.txt');
		filePath = HOME + '/' + name;

		var dotvim = HOME + '/.vim';
		var files = {};
		files[filePath] = typeof boot.value === 'string' ? boot.value : '';
		// The editor's vimrc: sensible defaults, a bundled colorscheme, then the
		// user's startup Vimscript (the "exrc" field in the options page).
		files[dotvim + '/vimrc'] =
			'set nocompatible\n' +
			'filetype plugin indent on\n' +
			'syntax enable\n' +
			// mouse=a: forward click/drag/scroll to Vim in every mode (the
			// agent's iframe captures the canvas mouse events and relays them).
			'set mouse=a\n' +
			// the "+" (and "*") register is the system clipboard, as in real Vim;
			// default y/d/p stay in the in-memory unnamed register. Use "+y / "+p
			// for the system clipboard, or set clipboard=unnamed[plus] in exrc.
			'silent! colorscheme vividchalk\n' +
			(typeof exrc === 'string' ? exrc : '') + '\n';

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
		vim.readClipboard = readClipboard;
		vim.onWriteClipboard = writeClipboard;

		// Export the buffer on every successful write so the host element is
		// kept in sync, exactly like ":w" in the original engine.
		var autocmd =
			"autocmd BufWritePost * silent! execute 'export ' . fnameescape(expand('%:p'))";

		var cmdArgs = ['-n', '-c', autocmd];
		if (boot.readOnly) cmdArgs.push('-R');
		cmdArgs.push(filePath);

		// Fetch the bundled colorscheme(s) into ~/.vim/colors so `colorscheme`
		// works. The worker fetches these before Vim's main loop starts.
		var fetchFiles = {};
		fetchFiles[dotvim + '/colors/vividchalk.vim'] = resourceURL('frontend/colors/vividchalk.vim');

		// NOTE: do not pass dirs:[HOME] - /home/web_user already exists in the
		// vim.data image, and FS.mkdir() on it throws ("FS error"). ~/.vim is
		// created by the runtime; ~/.vim/colors is not, so create it here.
		vim.start({
			clipboard: true,
			dirs: [dotvim + '/colors'],
			files: files,
			fetchFiles: fetchFiles,
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

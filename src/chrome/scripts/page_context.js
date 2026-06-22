/**
 * page-context script for wasavi frontend
 *
 * @author akahuku@gmail.com
 */
/**
 * Copyright 2012-2016 akahuku, akahuku@gmail.com
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

!(function(win,doc){

// An object that quacks like a Monaco standalone code editor.
function isMonacoEditor (o) {
	return !!o && typeof o.getModel === 'function'
		&& typeof o.getValue === 'function'
		&& typeof o.getDomNode === 'function';
}

// Strategy 1: the monaco namespace, either global (LeetCode) or pulled out of a
// webpack 5 module cache (CoderPad and other bundled apps don't expose it).
var cachedNamespace; // undefined = not tried, null = tried & failed
function getMonacoNamespace () {
	if (cachedNamespace !== undefined) return cachedNamespace;
	cachedNamespace = null;
	if (win.monaco && win.monaco.editor && win.monaco.editor.getEditors) {
		cachedNamespace = win.monaco;
		return cachedNamespace;
	}
	try {
		var keys = Object.keys(win).filter(function (k) {
			return /^webpackChunk/.test(k) && Array.isArray(win[k]);
		});
		for (var ki = 0; ki < keys.length && !cachedNamespace; ki++) {
			var req;
			win[keys[ki]].push([['wasavi_probe_' + ki + '_' + (win.performance ? Math.floor(win.performance.now()) : keys.length)],
				{}, function (r) { req = r; }]);
			if (!req || !req.c) continue;
			for (var id in req.c) {
				var ex = req.c[id] && req.c[id].exports;
				if (!ex) continue;
				if (ex.editor && typeof ex.editor.getEditors === 'function') { cachedNamespace = ex; break; }
				if (ex.default && ex.default.editor && typeof ex.default.editor.getEditors === 'function') { cachedNamespace = ex.default; break; }
			}
		}
	} catch (ex) {
		console.warn('[wasavi-monaco] webpack namespace probe failed:', ex);
	}
	return cachedNamespace;
}

// Strategy 2: walk the React fiber on the node (CoderPad keeps the editor in a
// React component) looking for an object that quacks like a Monaco editor.
function findEditorViaReactFiber (node) {
	for (var el = node; el; el = el.parentElement) {
		var fk = null, keys = Object.keys(el);
		for (var i = 0; i < keys.length; i++) {
			if (keys[i].indexOf('__reactFiber$') === 0 || keys[i].indexOf('__reactInternalInstance$') === 0) { fk = keys[i]; break; }
		}
		if (!fk) continue;
		var depth = 0, seen = (typeof WeakSet === 'function') ? new WeakSet() : null;
		for (var f = el[fk]; f && depth < 80; f = f.return, depth++) {
			var ed = scanForEditor(f.memoizedProps, 0, seen)
				|| scanForEditor(f.memoizedState, 0, seen)
				|| scanForEditor(f.stateNode, 0, seen);
			if (ed) return ed;
		}
	}
	return null;
}
// Walk an object graph (React props/state/hooks) for something that quacks like
// a Monaco editor. Cycle-guarded so we can scan a few levels deep safely.
function scanForEditor (o, depth, seen) {
	if (!o || typeof o !== 'object' || depth > 6) return null;
	if (seen) { if (seen.has(o)) return null; try { seen.add(o); } catch (ex) {} }
	if (isMonacoEditor(o)) return o;
	var keys;
	try { keys = Object.keys(o); } catch (ex) { return null; }
	for (var i = 0; i < keys.length; i++) {
		var v;
		try { v = o[keys[i]]; } catch (ex) { continue; }
		if (isMonacoEditor(v)) return v;
		if (v && typeof v === 'object') { var r = scanForEditor(v, depth + 1, seen); if (r) return r; }
	}
	return null;
}

// Find the Monaco editor instance whose DOM node corresponds to `node`.
function findMonacoEditor (node) {
	var ns = getMonacoNamespace();
	if (ns) {
		try {
			var editors = ns.editor.getEditors();
			for (var i = 0; i < editors.length; i++) {
				var dom = editors[i].getDomNode && editors[i].getDomNode();
				if (dom && (dom === node || node.contains(dom) || dom.contains(node))) return editors[i];
			}
			if (editors.length) return editors[0];
		} catch (ex) {}
	}
	var viaFiber = findEditorViaReactFiber(node);
	if (viaFiber) return viaFiber;
	console.warn('[wasavi-monaco] could not reach a Monaco editor (no global, webpack, or React fiber match)');
	return null;
}

// Read-only fallback: scrape the rendered .view-lines (visible lines only).
function readViewLines (node) {
	var vl = node.querySelector ? node.querySelector('.view-lines') : null;
	if (!vl) return null;
	var lines = Array.prototype.slice.call(vl.querySelectorAll('.view-line'));
	if (!lines.length) return null;
	lines.sort(function (a, b) { return (parseInt(a.style.top, 10) || 0) - (parseInt(b.style.top, 10) || 0); });
	return lines.map(function (l) { return (l.textContent || '').replace(/\u00a0/g, ' '); }).join('\n');
}

doc.addEventListener('WasaviRequestGetContent', function (e) {
	var className = e.detail;
	var node = doc.getElementsByClassName(className)[0];
	if (!node) return;

	var result = '';
	if (node.CodeMirror)
		try {result = node.CodeMirror.getValue()} catch (ex) {result = ''}
	else if (node.classList.contains('ace_editor') && win.ace)
		try {result = win.ace.edit(node).getValue()} catch(ex) {result = ''}
	else if (node.classList.contains('monaco-editor')) {
		var ed = findMonacoEditor(node);
		if (ed) try {result = ed.getValue()} catch (ex) {result = ''}
		if (!result) {
			var vl = readViewLines(node);
			if (vl != null) result = vl;
			if (vl != null) console.warn('[wasavi-monaco] using .view-lines fallback (visible lines only; write-back will not work)');
		}
		console.log('[wasavi-monaco] read: editor=' + !!ed + ' length=' + (result ? result.length : 0));
	}

	var ev = doc.createEvent('CustomEvent');
	ev.initCustomEvent('WasaviResponseGetContent', false, false, className + '\t' + result);
	doc.dispatchEvent(ev);
}, false);

doc.addEventListener('WasaviRequestSetContent', function (e) {
	var delimiterIndex = e.detail.indexOf('\t');
	var className = e.detail.substring(0, delimiterIndex);
	var content = e.detail.substring(delimiterIndex + 1);
	var node = doc.getElementsByClassName(className)[0];
	if (!node) return;

	node.classList.remove(className);
	if (node.CodeMirror)
		try {node.CodeMirror.setValue(content)} catch (ex) {}
	else if (node.classList.contains('ace_editor') && win.ace)
		try {win.ace.edit(node).setValue(content)} catch(ex) {}
	else if (node.classList.contains('monaco-editor')) {
		var ed = findMonacoEditor(node);
		if (ed) try {
			// setValue on the model preserves the editor/view; it replaces the
			// whole document, which is what wasavi's write-back means.
			var model = ed.getModel();
			if (model) model.setValue(content); else ed.setValue(content);
		} catch (ex) {}
	}
}, false);
})(window,document);

// vim:set ts=4 sw=4 fileencoding=UTF-8 fileformat=unix filetype=javascript fdm=marker :

/*
WEB_LIBRARY.JS

The JavaScript half of the web runtime (web_sdl.c), which runs on the game's
own thread (a Web Worker).

The game's WebGL 2 context draws into an OffscreenCanvas of this thread.
The game never returns to the worker's event loop, so frames cannot be
committed to a canvas on the page the usual way: each frame is taken out as
an ImageBitmap (transferToImageBitmap needs no event loop) and posted to the
page, which shows it (Module.haloPresent in port/web/site/app.js).
*/

addToLibrary({
  $webHalo: {
    canvas: null,
    // the number the main thread's pthread message handler uses for
    // Module[handler](...args) (Emscripten's CMD_CALL_HANDLER)
    callHandler: 9,
    post(handler, args, transfer) {
      if (ENVIRONMENT_IS_PTHREAD) {
        postMessage({ cmd: webHalo.callHandler, handler, args }, transfer || []);
      } else {
        Module[handler]?.(...args);
      }
    },
    // HALO_WEB_GL_STATS: counts the WebGL calls and reports them per frame
    calls: null,
    callTime: null,
    frames: 0,
    bytesBy: {},
    countCalls(context) {
      var calls = webHalo.calls = {};
      var time = webHalo.callTime = {};
      for (let name in context) {
        let method = context[name];
        if (typeof method != 'function') continue;
        context[name] = function () {
          var start = performance.now();
          var result = method.apply(context, arguments);
          calls[name] = (calls[name] || 0) + 1;
          var a = arguments, bytes = 0;
          if (name == 'bufferSubData') bytes = typeof a[4] == 'number' ? a[4] : (a[2] && a[2].byteLength) || 0;
          else if (name == 'bufferData') bytes = typeof a[4] == 'number' ? a[4] : (a[1] && a[1].byteLength) || 0;
          else if (name == 'texImage2D' || name == 'texSubImage2D') bytes = (name == 'texImage2D' ? a[3] * a[4] : a[4] * a[5]) * 4;
          else if (name == 'texImage3D' || name == 'texSubImage3D') bytes = (name == 'texImage3D' ? a[3] * a[4] * a[5] : a[5] * a[6] * a[7]) * 4;
          else if (name == 'compressedTexImage2D' || name == 'compressedTexSubImage2D') bytes = a[a.length - 1] || 0;
          else if (name.startsWith('uniform') && name.endsWith('v')) bytes = (a[3] || 0) * 4;
          if (!(bytes > 0)) bytes = 0;
          webHalo.bytes = (webHalo.bytes || 0) + bytes;
          webHalo.bytesBy[name] = (webHalo.bytesBy[name] || 0) + (bytes || 0);
          time[name] = (time[name] || 0) + performance.now() - start;
          return result;
        };
      }
    },
    // HALO_GL_DEBUG: each WebGL call that fails, by name, with its
    // arguments (the first few times for each call and error)
    traceErrors(context) {
      var seen = {};
      var getError = context.getError.bind(context);
      var describe = (value) => {
        if (value === null || value === undefined) return String(value);
        if (typeof value == 'number') return value > 0x1000 && value < 0x10000 ? '0x' + value.toString(16) : String(value);
        if (typeof value == 'boolean' || typeof value == 'string') return String(value).slice(0, 40);
        if (ArrayBuffer.isView(value)) return value.constructor.name + '[' + value.length + ']';
        return Object.prototype.toString.call(value).slice(8, -1);
      };
      for (let name in context) {
        let method = context[name];
        if (typeof method != 'function' || name == 'getError') continue;
        context[name] = function () {
          var result = method.apply(context, arguments);
          var error = getError();
          if (error) {
            var key = name + error;
            seen[key] = (seen[key] || 0) + 1;
            if (seen[key] <= 3 || seen[key] == 100 || seen[key] == 1000) {
              var args = Array.prototype.map.call(arguments, describe).join(', ');
              var binding = '';
              try {
                if (/^(draw|clear|blit|copyTex|readPixels|framebuffer)/.test(name)) {
                  var fb = context.getParameter(context.DRAW_FRAMEBUFFER_BINDING);
                  binding = ' framebuffer ' + (fb ? 'bound, status 0x' + context.checkFramebufferStatus(context.DRAW_FRAMEBUFFER).toString(16) : 'default');
                }
              } catch (e) { /* none */ }
              webHalo.post('haloMessage', [0, `GL error 0x${error.toString(16)} in ${name}(${args})${binding} (${seen[key]} times)`]);
            }
          }
          return result;
        };
      }
    },
    // the browser took the graphics away (most often: the page used more
    // graphics memory than it allows): the page says so, and next time the
    // game asks for smaller textures (app.js)
    lostReported: false,
    contextLost() {
      if (webHalo.lostReported) return;
      webHalo.lostReported = true;
      webHalo.post('haloMessage', [3, 'The graphics context was lost: the browser stopped the game\'s graphics, most often because they ' +
        'needed more memory than it allows. Reload to continue: the game now uses smaller textures (Settings and data).']);
    },
    reportCalls() {
      if (++webHalo.frames % 60) return;
      var calls = webHalo.calls, time = webHalo.callTime, total = 0, totalTime = 0;
      for (var name in calls) { total += calls[name]; totalTime += time[name]; }
      var top = Object.keys(calls).sort((a, b) => time[b] - time[a]).filter((name) => calls[name]).slice(0, 3)
        .map((name) => `${name} ${(time[name] / 60).toFixed(1)}`);
      // the frame rate view's third line (app.js)
      webHalo.post('haloMessage', [7, `gl ${(total / 60).toFixed(0)} calls ${(totalTime / 60).toFixed(1)} ms · ${((webHalo.bytes || 0) / 60 / 1024).toFixed(0)} KB\n${top.join(' · ')}`]);
      for (var name in calls) { calls[name] = 0; time[name] = 0; }
      webHalo.bytes = 0; webHalo.bytesBy = {};
    },
  },

  web_js_gl_create__deps: ['$GL', '$webHalo'],
  web_js_gl_create: (width, height, statistics) => {
    if (typeof OffscreenCanvas == 'undefined') {
      webHalo.post('haloMessage', [3, 'This browser cannot draw from a worker (OffscreenCanvas). iOS 17 or later is needed.']);
      return 0;
    }
    var canvas = new OffscreenCanvas(width, height);
    var attributes = {
      alpha: false,
      depth: false,
      stencil: false,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false,
    };
    var context = canvas.getContext('webgl2', attributes);
    if (!context) {
      webHalo.post('haloMessage', [3, 'WebGL 2 is not available.']);
      return 0;
    }
    // (an OffscreenCanvas's event is 'contextlost'; the game's thread never
    // returns to its event loop, so each frame also asks: web_js_gl_present)
    for (var lost of ['contextlost', 'webglcontextlost']) {
      canvas.addEventListener?.(lost, (event) => { event.preventDefault(); webHalo.contextLost(); });
    }
    webHalo.canvas = canvas;
    webHalo.context = context;
    if (statistics & 1) webHalo.countCalls(context);
    if (statistics & 2) webHalo.traceErrors(context);
    var handle = GL.registerContext(context, Object.assign({
      majorVersion: 2,
      minorVersion: 0,
      enableExtensionsByDefault: 1,
    }, attributes));
    GL.makeContextCurrent(handle);
    return handle;
  },

  web_js_gl_resize__deps: ['$webHalo'],
  web_js_gl_resize: (width, height) => {
    var canvas = webHalo.canvas;
    if (canvas && (canvas.width != width || canvas.height != height)) {
      canvas.width = width;
      canvas.height = height;
    }
  },

  web_js_gl_present__deps: ['$webHalo'],
  web_js_gl_present: () => {
    var canvas = webHalo.canvas;
    if (!canvas) return;
    if (webHalo.context && !webHalo.lostReported && webHalo.context.isContextLost()) webHalo.contextLost();
    if (webHalo.calls) webHalo.reportCalls();
    var bitmap = canvas.transferToImageBitmap();
    webHalo.post('haloPresent', [bitmap], [bitmap]);
  },

  // remote co-op: a frame of the second player's own view, which goes to
  // their device instead of onto the page (Module.haloPresentView)
  web_js_gl_present_view__deps: ['$webHalo'],
  web_js_gl_present_view: () => {
    var canvas = webHalo.canvas;
    if (!canvas) return;
    var bitmap = canvas.transferToImageBitmap();
    webHalo.post('haloPresentView', [bitmap], [bitmap]);
  },

  // kind: 0 status, 1 notice, 2 clipboard text, 3 fatal error, 6 frame timing, 7 WebGL calls
  web_js_post__deps: ['$webHalo'],
  web_js_post: (kind, text) => {
    webHalo.post('haloMessage', [kind, UTF8ToString(text)]);
  },
});

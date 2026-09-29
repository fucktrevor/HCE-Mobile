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
          if (name == 'bufferSubData' || name == 'bufferData') bytes = typeof a[4] == 'number' ? a[4] : (a[2] && a[2].byteLength) || 0;
          else if (name == 'texImage2D' || name == 'texSubImage2D') bytes = (name == 'texImage2D' ? a[3] * a[4] : a[4] * a[5]) * 4;
          else if (name == 'texImage3D' || name == 'texSubImage3D') bytes = (name == 'texImage3D' ? a[3] * a[4] * a[5] : a[5] * a[6] * a[7]) * 4;
          else if (name == 'compressedTexImage2D' || name == 'compressedTexSubImage2D') bytes = a[a.length - 1] || 0;
          else if (name.startsWith('uniform') && name.endsWith('v')) bytes = (a[3] || 0) * 4;
          webHalo.bytes = (webHalo.bytes || 0) + (bytes || 0);
          webHalo.bytesBy[name] = (webHalo.bytesBy[name] || 0) + (bytes || 0);
          time[name] = (time[name] || 0) + performance.now() - start;
          return result;
        };
      }
    },
    reportCalls() {
      if (++webHalo.frames % 120) return;
      var calls = webHalo.calls, time = webHalo.callTime, total = 0, totalTime = 0;
      for (var name in calls) { total += calls[name]; totalTime += time[name]; }
      var top = Object.keys(calls).sort((a, b) => calls[b] - calls[a]).filter((name) => calls[name])
        .map((name) => `${name} ${(calls[name] / 120).toFixed(0)} ${(time[name] / 120).toFixed(2)}ms`);
      var by = Object.keys(webHalo.bytesBy).filter((n) => webHalo.bytesBy[n]).map((n) => `${n} ${(webHalo.bytesBy[n] / 120 / 1024).toFixed(0)}K`).join(', ');
      webHalo.post('haloMessage', [0, `GL per frame: ${((webHalo.bytes || 0) / 120 / 1024).toFixed(0)} KB (${by}); ${(total / 120).toFixed(0)} calls ${(totalTime / 120).toFixed(2)}ms; ` + top.join(', ')]);
      webHalo.bytes = 0; webHalo.bytesBy = {};
      for (var name in calls) { calls[name] = 0; time[name] = 0; }
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
    canvas.addEventListener?.('webglcontextlost', (event) => {
      event.preventDefault();
      webHalo.post('haloMessage', [3, 'The graphics context was lost. Reload the page to continue.']);
    });
    webHalo.canvas = canvas;
    if (statistics) webHalo.countCalls(context);
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
    if (webHalo.calls) webHalo.reportCalls();
    var bitmap = canvas.transferToImageBitmap();
    webHalo.post('haloPresent', [bitmap], [bitmap]);
  },

  // kind: 0 status, 1 notice, 2 clipboard text, 3 fatal error, 6 frame timing
  web_js_post__deps: ['$webHalo'],
  web_js_post: (kind, text) => {
    webHalo.post('haloMessage', [kind, UTF8ToString(text)]);
  },
});

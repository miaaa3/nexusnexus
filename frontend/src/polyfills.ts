/**
 * Polyfills required before any CommonJS module is evaluated.
 *
 * sockjs-client and @stomp/stompjs were written for Node/CommonJS and
 * reference `global` and `process` which do not exist in browsers.
 * Defining them here (loaded first via angular.json polyfills array)
 * prevents "global is not defined" / "process is not defined" errors.
 */
(window as any).global  = window;
(window as any).process = { env: {} };

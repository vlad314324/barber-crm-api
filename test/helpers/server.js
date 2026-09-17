// Піднімає app.js на ефемерному порту (0 -> ОС сама обирає вільний), щоб
// паралельні тестові файли не конфліктували за один і той самий порт 5000,
// який використовує звичайний `node server.js`.
const app = require('../../app');

function startTestServer() {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, (err) => {
      if (err) return reject(err);
      resolve(server);
    });
  });
}

function baseUrlFor(server) {
  return `http://127.0.0.1:${server.address().port}/api`;
}

function stopTestServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    // server.close() alone only stops accepting NEW connections — it waits
    // for existing ones to end naturally before its callback fires. fetch()
    // (undici) keeps sockets alive for reuse, so without this the promise
    // above could hang well past the test itself finishing.
    server.closeAllConnections?.();
  });
}

module.exports = { startTestServer, baseUrlFor, stopTestServer };

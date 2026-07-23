const server = require('../../dist/server.cjs');

exports.handler = async (event, context) => {
  // Chuyển tiếp các yêu cầu HTTP từ Netlify Functions vào server Express/Node.js của bạn
  return server(event, context);
};

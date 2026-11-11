const env = require("../../config/env");
const createPool = require("./createPool");

const pool = createPool(env.DATABASE_URL);

module.exports = pool;
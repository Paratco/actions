// See shim/run-bun.cjs: runs the bundled action under a pinned Bun.
require("../../shim/run-bun.cjs")(require("node:path").join(__dirname, "../../dist/artifact.js"), ["download"]);

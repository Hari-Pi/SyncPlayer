const fs = require("fs");
let pr = fs.readFileSync("src/app/App.tsx", "utf-8");

pr = pr.replace("setDrift({ driftMs: 0, mode: \"hold\" });", "setDrift({ driftMs: 0, mode: \"hold\", rate: 1.0 });");

fs.writeFileSync("src/app/App.tsx", pr);

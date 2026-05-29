import MP4Box from "mp4box";
import fs from "fs";

const fileData = fs.readFileSync("/Users/hari/Projects/SyncPlayer/apps/web/package.json"); // Just dummy, we won't feed actual mp4 yet, let's just see API
console.log(Object.keys(MP4Box.createFile()));

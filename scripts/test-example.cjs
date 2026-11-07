const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {prepare,shells} = require('./prepare-example.cjs');
for (const variant of Object.keys(shells)) {
  const dir = prepare(variant);
  const meta = JSON.parse(fs.readFileSync(path.join(dir,'character/character.json')));
  const actions = JSON.parse(fs.readFileSync(path.join(dir,'character/actions.json')));
  assert(actions.some(a=>a.id===meta.defaultAction));
  for (const a of actions) {
    const png = fs.readFileSync(path.join(dir,'character/assets/gifs',a.file));
    assert.equal(png.readUInt32BE(16),256);
    assert(fs.existsSync(path.join(dir,'character/assets/previews',a.id+'.png')));
  }
  assert.equal(meta.features.aiChat,variant==='ai');
  assert.equal(meta.features.growth,variant==='growth');
  console.log('PASS example prepare: '+variant);
}

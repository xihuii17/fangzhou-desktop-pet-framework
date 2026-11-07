// Invoke with Electron, e.g. electron scripts/smoke-electron.cjs standard.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {prepare}=require('./prepare-example.cjs');
const variant=process.argv[2]||'standard';
const dir=prepare(variant);
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'example-pet-smoke-')));
process.chdir(dir);
app.setAppPath(dir);
const errors=[];
app.on('web-contents-created',(_,contents)=>{
  contents.on('preload-error',(_,file,error)=>errors.push(String(error)));
  contents.on('render-process-gone',(_,details)=>errors.push(details.reason));
});
require(path.join(dir,'main.js'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const deadline=setTimeout(()=>{console.error('FAIL smoke timeout '+variant);app.exit(1);},25000);
app.whenReady().then(async()=>{
  let pet;
  for(let i=0;i<100;i++){
    pet=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('pet.html'));
    if(pet&&!pet.webContents.isLoading())break;
    await sleep(100);
  }
  assert(pet,'pet window created');
  await sleep(1500);
  const result=await pet.webContents.executeJavaScript(`(async()=>{
    const character=await companionAPI.getCharacter();
    const config=await companionAPI.getConfig();
    const actions=await companionAPI.getActions();
    await companionAPI.openSettings();
    return {id:character.id,config:!!config,actions:!!actions,images:[...document.images].filter(i=>i.naturalWidth>0).length};
  })()`);
  assert.equal(result.id,'example');assert(result.config&&result.actions);assert(result.images>0);
  await sleep(1000);
  const settings=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('settings.html'));
  assert(settings,'settings IPC opens settings window');
  if(variant==='ai'){
    const status=await settings.webContents.executeJavaScript('companionAPI.getAIStatus()');
    assert.equal(status.configured,false,'fresh profile has no API key');
  }
  assert.equal(errors.length,0,errors.join('\n'));
  console.log('PASS native Electron '+variant+': image, character/config/actions IPC, settings'+(variant==='ai'?', missing-key status':''));
  clearTimeout(deadline);app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});

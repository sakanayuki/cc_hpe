import './style.css';
import { imageToCloud, type GaussianCloud } from './gaussian';
import { download, exportPly, exportSplat } from './exporters';
import { SplatViewer, type RenderMode } from './viewer';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('App root not found');

app.innerHTML = `
  <header><a class="brand" href="#"><span class="mark">PS</span><span>PoseSplat <b>Studio</b></span></a><div class="local"><i></i> ローカル処理のみ</div></header>
  <main>
    <section class="hero" aria-labelledby="title"><div><p class="eyebrow">BROWSER-ONLY 3D CREATION</p><h1 id="title">一枚の写真に、<br><em>奥行きを。</em></h1><p class="lead">人物写真から姿勢と深度を推定し、Gaussian Splatとして立体化します。画像が端末の外に送信されることはありません。</p></div><div class="chips"><span>WebGPU</span><span>最大 500K splats</span><span>PLY / SPLAT</span></div></section>
    <section class="workspace">
      <aside class="panel controls" aria-label="生成設定">
        <div class="step"><span>01</span><div><b>写真を選択</b><small>人物が1人の画像</small></div></div>
        <label class="drop" id="drop"><input id="file" type="file" accept="image/png,image/jpeg,image/webp"/><span class="upload-icon">＋</span><strong>写真をドロップ</strong><small>またはクリックして選択 · JPG / PNG / WebP</small></label>
        <div id="thumbWrap" class="thumb-wrap hidden"><img id="thumb" alt="選択した人物写真"/><button id="clear" aria-label="写真を削除">×</button></div>
        <div class="divider"></div>
        <div class="step"><span>02</span><div><b>立体化の設定</b><small>端末性能に合わせて調整</small></div></div>
        <label class="field"><span>最大Splat数 <output id="countOut">120,000</output></span><input id="count" type="range" min="10000" max="500000" step="10000" value="120000"/></label>
        <label class="field"><span>奥行きの強さ <output id="depthOut">100%</output></span><input id="depth" type="range" min="20" max="180" value="100"/></label>
        <button class="primary" id="generate" disabled><span>✦</span> 3D Splatを生成</button>
        <p id="status" class="status" role="status">写真を選択してください</p>
      </aside>
      <section class="viewer-card" aria-label="3Dビューアー">
        <div class="toolbar"><div class="segmented" role="group" aria-label="表示情報"><button class="active" data-mode="color">カラー</button><button data-mode="depth">深度</button><button data-mode="opacity">不透明度</button><button data-mode="confidence">信頼度</button></div><button id="reset" class="icon-button" title="視点をリセット">↻</button></div>
        <div id="viewer" class="viewer"><div id="empty" class="empty"><div class="orb"><span></span></div><strong>3Dプレビュー</strong><p>写真を選択して生成すると、<br>ここにSplatが表示されます</p></div><div id="angle" class="angle hidden">品質保証範囲外 · <b>0°</b></div></div>
        <footer class="viewer-footer"><span><kbd>ドラッグ</kbd> 回転</span><span><kbd>ホイール</kbd> ズーム</span><span id="stats">0 splats</span></footer>
      </section>
    </section>
    <section id="exports" class="exports hidden"><div><p class="eyebrow">EXPORT</p><h2>生成結果を保存</h2><p>デバッグ属性はPLYに保持されます。SPLATでは深度と信頼度が失われます。</p></div><div class="export-buttons"><button id="ply">↓ <span><b>PLY</b><small>SuperSplat互換</small></span></button><button id="splat">↓ <span><b>SPLAT</b><small>32-byte形式</small></span></button><button disabled title="SPZ WASM encoderは次フェーズ">↓ <span><b>SPZ</b><small>次フェーズ</small></span></button></div></section>
  </main><footer class="site-footer">PoseSplat Studio · 画像はすべてこの端末内で処理されます</footer>`;

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fileInput = byId<HTMLInputElement>('file');
const generate = byId<HTMLButtonElement>('generate');
const count = byId<HTMLInputElement>('count');
const depth = byId<HTMLInputElement>('depth');
const status = byId('status');
const viewer = new SplatViewer(byId('viewer'), (angle) => {
  const warning = byId('angle'); warning.classList.toggle('hidden', angle <= 25); warning.querySelector('b')!.textContent = `${Math.round(angle)}°`;
});
let sourceImage: HTMLImageElement | undefined;
let cloud: GaussianCloud | undefined;

count.addEventListener('input', () => byId<HTMLOutputElement>('countOut').value = Number(count.value).toLocaleString('ja-JP'));
depth.addEventListener('input', () => byId<HTMLOutputElement>('depthOut').value = `${depth.value}%`);
fileInput.addEventListener('change', () => { const file=fileInput.files?.[0]; if(file) void loadFile(file); });
byId('clear').addEventListener('click', clear);
byId('reset').addEventListener('click', () => viewer.reset());
document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('[data-mode]').forEach(item => item.classList.remove('active')); button.classList.add('active'); viewer.setMode(button.dataset.mode as RenderMode);
}));

async function loadFile(file: File): Promise<void> {
  if (file.size > 25 * 1024 * 1024) { status.textContent='25 MB以下の画像を選択してください'; return; }
  const url=URL.createObjectURL(file); const image=new Image(); image.decoding='async'; image.src=url;
  try { await image.decode(); sourceImage=image; byId<HTMLImageElement>('thumb').src=url; byId('thumbWrap').classList.remove('hidden'); generate.disabled=false; status.textContent=`${image.naturalWidth} × ${image.naturalHeight} px · 準備完了`; }
  catch { URL.revokeObjectURL(url); status.textContent='画像を読み込めませんでした'; }
}

function clear(): void { sourceImage=undefined;fileInput.value='';byId('thumbWrap').classList.add('hidden');generate.disabled=true;status.textContent='写真を選択してください'; }

generate.addEventListener('click', async () => {
  if (!sourceImage) return; generate.disabled=true;status.textContent='画像を解析しています…'; await new Promise(requestAnimationFrame);
  const max=1400, ratio=Math.min(1,max/Math.max(sourceImage.naturalWidth,sourceImage.naturalHeight));
  const canvas=document.createElement('canvas');canvas.width=Math.round(sourceImage.naturalWidth*ratio);canvas.height=Math.round(sourceImage.naturalHeight*ratio);
  const context=canvas.getContext('2d',{willReadFrequently:true});if(!context) return;context.drawImage(sourceImage,0,0,canvas.width,canvas.height);
  cloud=imageToCloud(context.getImageData(0,0,canvas.width,canvas.height),{maxSplats:Number(count.value),depthStrength:Number(depth.value)/100,alphaThreshold:8});
  viewer.setCloud(cloud);byId('empty').classList.add('hidden');byId('exports').classList.remove('hidden');byId('stats').textContent=`${cloud.count.toLocaleString('ja-JP')} splats`;status.textContent='生成が完了しました';generate.disabled=false;
});

byId('ply').addEventListener('click',()=>cloud&&download(exportPly(cloud),'posesplat.ply'));
byId('splat').addEventListener('click',()=>cloud&&download(exportSplat(cloud),'posesplat.splat'));


import "./style.css";
import { imageToCloud, type GaussianCloud } from "./gaussian";
import { download, exportPly, exportSplat, exportSpz } from "./exporters";
import { SplatViewer, type RenderMode } from "./viewer";
import { detectSinglePerson } from "./pose";
import type { PoseGuidance } from "./pose";
import { getContainRect, mapLandmarkToContain } from "./pose-overlay";
import {
  BodyViewer,
  EDITABLE_JOINTS,
  JOINT_LABELS,
  type JointId,
} from "./body-viewer";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("App root not found");

app.innerHTML = `
  <header><a class="brand" href="#"><span class="mark">PS</span><span>PoseSplat <b>Studio</b></span></a><div class="local"><i></i> ローカル処理のみ</div></header>
  <main>
    <section class="hero" aria-labelledby="title"><div><p class="eyebrow">BROWSER-ONLY 3D CREATION</p><h1 id="title">一枚の写真に、<br><em>奥行きを。</em></h1><p class="lead">人物写真から姿勢と深度を推定し、Gaussian Splatとして立体化します。画像が端末の外に送信されることはありません。</p></div><div class="chips"><span>WebGPU</span><span>最大 500K splats</span><span>PLY / SPLAT</span></div></section>
    <section class="workspace">
      <aside class="panel controls" aria-label="生成設定">
        <div class="step"><span>01</span><div><b>写真を選択</b><small>人物が1人の画像</small></div></div>
        <label class="drop" id="drop"><input id="file" type="file" accept="image/png,image/jpeg,image/webp"/><span class="upload-icon">＋</span><strong>写真をドロップ</strong><small>またはクリックして選択 · JPG / PNG / WebP</small></label>
        <div id="thumbWrap" class="thumb-wrap hidden"><img id="thumb" alt="選択した人物写真"/><canvas id="poseOverlay" aria-label="推定骨格"></canvas><button id="clear" aria-label="写真を削除">×</button></div>
        <button class="primary" id="estimate" disabled><span>1</span> 姿勢を推定して素体を表示</button>
        <div id="poseControls" class="pose-controls hidden">
          <h3>素体・関節の補正</h3>
          <label class="field"><span>姿勢の奥行き <output id="poseDepthOut">100%</output></span><input id="poseDepth" type="range" min="25" max="200" value="100"/></label>
          <label class="field"><span>体幅 <output id="bodyWidthOut">100%</output></span><input id="bodyWidth" type="range" min="70" max="140" value="100"/></label><label class="field"><span>身長比 <output id="bodyHeightOut">100%</output></span><input id="bodyHeight" type="range" min="80" max="120" value="100"/></label><label class="field"><span>腕の長さ <output id="armLengthOut">100%</output></span><input id="armLength" type="range" min="75" max="130" value="100"/></label><label class="field"><span>脚の長さ <output id="legLengthOut">100%</output></span><input id="legLength" type="range" min="75" max="130" value="100"/></label>
          <div id="poseQuality" class="pose-quality"></div>
          <label class="joint-field"><span>補正する関節</span><select id="joint">${EDITABLE_JOINTS.map((id) => `<option value="${id}">${JOINT_LABELS[id]}</option>`).join("")}</select></label>
          <div class="joint-axes">${["X", "Y", "Z"].map((axis) => `<label><span>${axis} <output id="joint${axis}Out">0°</output></span><input id="joint${axis}" type="range" min="-90" max="90" value="0"/></label>`).join("")}</div>
          <div class="edit-actions"><button id="resetJoint">選択関節を戻す</button><button id="resetPose">全姿勢を戻す</button></div>
          <p>紫の関節をクリックして選択し、XYZを動かしてください。変更は即時反映されます。</p>
        </div>
        <div class="divider"></div>
        <div class="step"><span>02</span><div><b>3DGS化</b><small>素体のポーズ確認後に実行</small></div></div>
        <label class="field"><span>最大Splat数 <output id="countOut">120,000</output></span><input id="count" type="range" min="10000" max="500000" step="10000" value="120000"/></label>
        <label class="field"><span>奥行きの強さ <output id="depthOut">100%</output></span><input id="depth" type="range" min="20" max="180" value="100"/></label>
        <button class="primary" id="generate" disabled><span>2</span> 確認したポーズで3DGS化</button>
        <p id="status" class="status" role="status">写真を選択してください</p>
      </aside>
      <section class="viewer-card" aria-label="3Dビューアー">
        <div class="toolbar"><div><b id="stageLabel">STEP 1 · 素体GLBプレビュー</b><div class="segmented" id="views"><button data-view="front">正面</button><button data-view="side">側面</button><button data-view="back">背面</button><button data-view="top">上面</button></div><div class="segmented hidden" id="modes" role="group" aria-label="表示情報"><button class="active" data-mode="color">カラー</button><button data-mode="depth">深度</button><button data-mode="opacity">不透明度</button><button data-mode="confidence">信頼度</button><button data-mode="source">生成層</button></div><div id="filters" class="viewer-filters hidden"><label>信頼度 <input id="minConfidence" type="range" min="0" max="100" value="0"/><output id="minConfidenceOut">0%</output></label><select id="layerFilter" aria-label="生成層フィルター"><option value="-1">全生成層</option><option value="0">前面のみ</option><option value="1">中心のみ</option><option value="2">推定背面のみ</option></select></div></div><button id="reset" class="icon-button" title="視点をリセット">↻</button></div>
        <div id="viewer" class="viewer"><div id="empty" class="empty"><div class="orb"><span></span></div><strong>姿勢付き素体プレビュー</strong><p>写真を選びSTEP 1を実行すると、<br>推定ポーズを適用したGLB素体を表示します</p></div><div id="angle" class="angle hidden">品質保証範囲外 · <b>0°</b></div></div>
        <footer class="viewer-footer"><span><kbd>ドラッグ</kbd> 回転</span><span><kbd>ホイール</kbd> ズーム</span><span id="fps">-- FPS</span><span id="stats">0 splats</span></footer>
      </section>
    </section>
    <section id="exports" class="exports hidden"><div><p class="eyebrow">EXPORT</p><h2>生成結果を保存</h2><p>デバッグ属性はPLYに保持されます。SPLATでは深度と信頼度が失われます。</p></div><div class="export-buttons"><button id="ply">↓ <span><b>PLY</b><small>SuperSplat互換</small></span></button><button id="splat">↓ <span><b>SPLAT</b><small>32-byte形式</small></span></button><button id="spz">↓ <span><b>SPZ</b><small>Niantic v3</small></span></button></div></section>
  </main><footer class="site-footer">PoseSplat Studio · 画像はすべてこの端末内で処理されます</footer>`;

const byId = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const fileInput = byId<HTMLInputElement>("file");
const generate = byId<HTMLButtonElement>("generate");
const estimate = byId<HTMLButtonElement>("estimate");
const count = byId<HTMLInputElement>("count");
const depth = byId<HTMLInputElement>("depth");
const status = byId("status");
const minConfidence = byId<HTMLInputElement>("minConfidence"),
  layerFilter = byId<HTMLSelectElement>("layerFilter");
let jointId: JointId = "hips";
const selectJoint = (id: JointId) => {
  jointId = id;
  byId<HTMLSelectElement>("joint").value = id;
  syncJointControls();
};
const bodyViewer = new BodyViewer(byId("viewer"), selectJoint);
const viewer = new SplatViewer(
  byId("viewer"),
  (angle) => {
    const warning = byId("angle");
    warning.classList.toggle("hidden", angle <= 25);
    warning.querySelector("b")!.textContent = `${Math.round(angle)}°`;
  },
  (fps) => {
    const output = byId("fps");
    output.textContent = `${Math.round(fps)} FPS`;
    output.classList.toggle("bad", fps < 30);
  },
);
viewer.setVisible(false);
minConfidence.addEventListener("input", () => {
  byId<HTMLOutputElement>("minConfidenceOut").value = `${minConfidence.value}%`;
  viewer.setMinConfidence(Number(minConfidence.value) / 100);
});
layerFilter.addEventListener("change", () =>
  viewer.setLayer(Number(layerFilter.value)),
);
let sourceImage: HTMLImageElement | undefined;
let cloud: GaussianCloud | undefined;
let pose: PoseGuidance | undefined;

count.addEventListener(
  "input",
  () =>
    (byId<HTMLOutputElement>("countOut").value = Number(
      count.value,
    ).toLocaleString("ja-JP")),
);
depth.addEventListener(
  "input",
  () => (byId<HTMLOutputElement>("depthOut").value = `${depth.value}%`),
);
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) void loadFile(file);
});
byId("clear").addEventListener("click", clear);
byId("reset").addEventListener("click", () =>
  bodyViewer.isVisible() ? bodyViewer.reset() : viewer.reset(),
);
document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((button) =>
  button.addEventListener("click", () => {
    document
      .querySelectorAll("[data-mode]")
      .forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    viewer.setMode(button.dataset.mode as RenderMode);
  }),
);
const poseDepth = byId<HTMLInputElement>("poseDepth"),
  bodyWidth = byId<HTMLInputElement>("bodyWidth"),
  bodyHeight = byId<HTMLInputElement>("bodyHeight"),
  armLength = byId<HTMLInputElement>("armLength"),
  legLength = byId<HTMLInputElement>("legLength"),
  joint = byId<HTMLSelectElement>("joint");
const jointAxes = ["X", "Y", "Z"] as const;
poseDepth.addEventListener("input", () => {
  byId<HTMLOutputElement>("poseDepthOut").value = `${poseDepth.value}%`;
  bodyViewer.setDepthScale(Number(poseDepth.value) / 100);
});
bodyWidth.addEventListener("input", () => {
  byId<HTMLOutputElement>("bodyWidthOut").value = `${bodyWidth.value}%`;
  bodyViewer.setBodyWidth(Number(bodyWidth.value) / 100);
});
bodyHeight.addEventListener("input", () => {
  byId<HTMLOutputElement>("bodyHeightOut").value = `${bodyHeight.value}%`;
  bodyViewer.setBodyHeight(Number(bodyHeight.value) / 100);
});
const applyLengths = () =>
  bodyViewer.setLimbLengths(
    Number(armLength.value) / 100,
    Number(legLength.value) / 100,
  );
armLength.addEventListener("input", () => {
  byId<HTMLOutputElement>("armLengthOut").value = `${armLength.value}%`;
  applyLengths();
});
legLength.addEventListener("input", () => {
  byId<HTMLOutputElement>("legLengthOut").value = `${legLength.value}%`;
  applyLengths();
});
const applyJoint = () => {
  const values = jointAxes.map((axis) =>
    Number(byId<HTMLInputElement>(`joint${axis}`).value),
  );
  bodyViewer.setJointCorrection(jointId, values[0], values[1], values[2]);
};
jointAxes.forEach((axis) =>
  byId<HTMLInputElement>(`joint${axis}`).addEventListener("input", (event) => {
    byId<HTMLOutputElement>(`joint${axis}Out`).value =
      `${(event.target as HTMLInputElement).value}°`;
    applyJoint();
  }),
);
function syncJointControls() {
  const values = bodyViewer.getJointCorrection(jointId);
  jointAxes.forEach((axis, i) => {
    byId<HTMLInputElement>(`joint${axis}`).value = String(
      Math.round(values[i]),
    );
    byId<HTMLOutputElement>(`joint${axis}Out`).value =
      `${Math.round(values[i])}°`;
  });
  bodyViewer.selectJoint(jointId);
}
joint.addEventListener("change", () => {
  jointId = joint.value as JointId;
  syncJointControls();
});
byId("resetJoint").addEventListener("click", () => {
  bodyViewer.resetJoint(jointId);
  syncJointControls();
});
byId("resetPose").addEventListener("click", () => {
  bodyViewer.resetPose();
  syncJointControls();
});
document
  .querySelectorAll<HTMLButtonElement>("[data-view]")
  .forEach((button) =>
    button.addEventListener("click", () =>
      bodyViewer.setView(
        button.dataset.view as "front" | "side" | "back" | "top",
      ),
    ),
  );

const SKELETON = [
  [11, 12],
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
  [11, 23],
  [12, 24],
  [23, 24],
  [23, 25],
  [25, 27],
  [27, 31],
  [24, 26],
  [26, 28],
  [28, 32],
  [0, 11],
  [0, 12],
];
function drawPoseOverlay(guidance: PoseGuidance) {
  const canvas = byId<HTMLCanvasElement>("poseOverlay"),
    thumbWrap = byId<HTMLDivElement>("thumbWrap");
  const w = thumbWrap.clientWidth,
    h = thumbWrap.clientHeight;
  canvas.width = Math.round(w * devicePixelRatio);
  canvas.height = Math.round(h * devicePixelRatio);
  const c = canvas.getContext("2d")!;
  c.scale(devicePixelRatio, devicePixelRatio);
  if (!sourceImage) return;
  const imageRect = getContainRect(
    { width: sourceImage.naturalWidth, height: sourceImage.naturalHeight },
    { width: w, height: h },
  );
  c.strokeStyle = "#c7a8ff";
  c.lineWidth = 2;
  c.fillStyle = "#ff9bd2";
  for (const [a, b] of SKELETON) {
    const p = guidance.landmarks[a],
      q = guidance.landmarks[b];
    c.beginPath();
    const start = mapLandmarkToContain(p, imageRect),
      end = mapLandmarkToContain(q, imageRect);
    c.moveTo(start.x, start.y);
    c.lineTo(end.x, end.y);
    c.stroke();
  }
  for (const p of guidance.landmarks) {
    if ((p.visibility ?? 1) < 0.3) continue;
    c.beginPath();
    const point = mapLandmarkToContain(p, imageRect);
    c.arc(point.x, point.y, 2.5, 0, Math.PI * 2);
    c.fill();
  }
}

const thumbnailResizeObserver = new ResizeObserver(() => {
  if (pose) drawPoseOverlay(pose);
});
thumbnailResizeObserver.observe(byId("thumbWrap"));

async function loadFile(file: File): Promise<void> {
  if (file.size > 25 * 1024 * 1024) {
    status.textContent = "25 MB以下の画像を選択してください";
    return;
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  try {
    await image.decode();
    sourceImage = image;
    pose = undefined;
    byId<HTMLDivElement>("thumbWrap").style.setProperty(
      "--image-aspect",
      `${image.naturalWidth} / ${image.naturalHeight}`,
    );
    byId<HTMLImageElement>("thumb").src = url;
    byId("thumbWrap").classList.remove("hidden");
    byId("poseControls").classList.add("hidden");
    byId("exports").classList.add("hidden");
    estimate.disabled = false;
    generate.disabled = true;
    status.textContent = `${image.naturalWidth} × ${image.naturalHeight} px · STEP 1を実行してください`;
  } catch {
    URL.revokeObjectURL(url);
    status.textContent = "画像を読み込めませんでした";
  }
}

function clear(): void {
  sourceImage = undefined;
  pose = undefined;
  fileInput.value = "";
  byId("thumbWrap").classList.add("hidden");
  byId("poseControls").classList.add("hidden");
  byId("exports").classList.add("hidden");
  estimate.disabled = true;
  generate.disabled = true;
  status.textContent = "写真を選択してください";
}

estimate.addEventListener("click", async () => {
  if (!sourceImage) return;
  estimate.disabled = true;
  status.textContent = "人物の3D姿勢を推定し、GLB素体へ適用しています…";
  try {
    pose = await detectSinglePerson(sourceImage);
    drawPoseOverlay(pose);
    const application = await bodyViewer.showPose(
      pose,
      Number(poseDepth.value) / 100,
    );
    bodyViewer.setVisible(true);
    viewer.setVisible(false);
    syncJointControls();
    byId("empty").classList.add("hidden");
    byId("poseControls").classList.remove("hidden");
    byId("stageLabel").textContent = "STEP 1 · 姿勢付き素体GLB";
    byId("modes").classList.add("hidden");
    byId("views").classList.remove("hidden");
    const visible = pose.landmarks.filter(
      (p) => (p.visibility ?? 1) > 0.5,
    ).length;
    byId("poseQuality").textContent =
      `33関節を推定 · 高信頼 ${visible}/33 · 紫の骨格を写真上に表示`;
    generate.disabled = application.appliedBones === 0;
    const result = `姿勢推定成功 · GLB適用 ${application.appliedBones}ボーン · 欠落 ${application.missingBones.length}ボーン`;
    status.textContent = application.missingBones.length
      ? `${result}（${application.missingBones.join("、")}）`
      : `${result} · 素体を回転して姿勢を確認・補正してください`;
  } catch (error) {
    pose = undefined;
    status.textContent =
      error instanceof Error ? error.message : "姿勢推定に失敗しました";
  } finally {
    estimate.disabled = false;
  }
});

generate.addEventListener("click", async () => {
  if (!sourceImage || !pose) return;
  generate.disabled = true;
  const startedAt = performance.now();
  status.textContent = "確認した骨格と人物領域から3DGS化しています…";
  await new Promise(requestAnimationFrame);
  try {
    pose.rigDepth = bodyViewer.captureDepth();
    pose.rigDepthWidth = 512;
    pose.rigDepthHeight = 512;
    const max = 1400,
      ratio = Math.min(
        1,
        max / Math.max(sourceImage.naturalWidth, sourceImage.naturalHeight),
      );
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(sourceImage.naturalWidth * ratio);
    canvas.height = Math.round(sourceImage.naturalHeight * ratio);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("画像処理を開始できませんでした。");
    context.drawImage(sourceImage, 0, 0, canvas.width, canvas.height);
    cloud = imageToCloud(
      context.getImageData(0, 0, canvas.width, canvas.height),
      {
        maxSplats: Number(count.value),
        depthStrength: Number(depth.value) / 100,
        alphaThreshold: 8,
      },
      pose,
    );
    viewer.setCloud(cloud);
    bodyViewer.setVisible(false);
    viewer.setVisible(true);
    byId("stageLabel").textContent = "STEP 2 · 3D Gaussian Splat";
    byId("views").classList.add("hidden");
    byId("modes").classList.remove("hidden");
    byId("filters").classList.remove("hidden");
    byId("exports").classList.remove("hidden");
    byId("stats").textContent = `${cloud.count.toLocaleString("ja-JP")} splats`;
    const seconds = (performance.now() - startedAt) / 1000;
    const plyMiB = (cloud.count * 68) / 1024 / 1024;
    status.textContent = `3DGS化完了 · ${seconds.toFixed(1)}秒 · PLY推定${plyMiB.toFixed(1)} MiB`;
  } catch (error) {
    status.textContent =
      error instanceof Error ? error.message : "推定に失敗しました";
  } finally {
    generate.disabled = false;
  }
});

byId("ply").addEventListener(
  "click",
  () => cloud && download(exportPly(cloud), "posesplat.ply"),
);
byId("splat").addEventListener(
  "click",
  () => cloud && download(exportSplat(cloud), "posesplat.splat"),
);
byId("spz").addEventListener("click", async () => {
  if (cloud) download(await exportSpz(cloud), "posesplat.spz");
});

# 単眼人物写真からのブラウザ完結 3D Gaussian Splatting 生成アプリ設計書

## 1. 文書の目的

本書は、利用者がアップロードした人物写真 1 枚から、人物 1 名の姿勢を推定し、リグ付き女性素体 FBX にポーズを適用して得た深度を使い、正面からの pitch / yaw の合成角が概ね 25° 以内の範囲で立体感のある 3D Gaussian Splatting（以下 3DGS）を生成・表示・書き出す静的 Web アプリの実装設計である。

配信サーバーで推論や変換を行わず、GitHub Pages から配信された静的ファイルをブラウザ内で実行する。推論は WebGPU を優先し、利用不能時だけ WebAssembly（WASM）へフォールバックする。モデルの変換・量子化およびサイトのビルドは GitHub Actions で再現可能にする。

依頼者から回答済みの事項は確定要件として扱う。未回答だった編集機能だけは [16.7 節](#167-残確認事項) の暫定値を採用する。

## 2. ゴールと非ゴール

### 2.1 ゴール

1. JPEG / PNG / WebP の人物写真を端末内だけで処理する。
2. 写真内の主要な人物 1 名を検出し、2D / 3D 関節と人物マスクを得る。
3. 同梱 FBX のスケルトンへ姿勢をリターゲットし、形状を写真の人物へ概略フィットさせる。
4. ポーズ付きメッシュから深度、法線、人物 ID、可視性を GPU でレンダリングする。
5. 原画像の色と推定深度から、少ない視差に耐える anisotropic Gaussian 群を構築する。
6. viewer で通常表示と、深度・色・不透明度・スケール・法線・信頼度等のデバッグ表示を切り替える。
7. `.ply`、`.splat`、`.spz` をローカルにダウンロードできる。
8. GitHub Actions から GitHub Pages へ、固定バージョンの成果物を安全かつ再現可能に配信する。

### 2.2 非ゴール（初期版）

- 背面、遮蔽された腕・脚、髪の奥側を写真どおりに復元すること。
- 合成角 25° を超える視点での品質保証、背面の忠実な復元、歩行アニメーション。viewer の操作自体は警告付きで 360° 許可する。
- 複数人物、動画、イラスト、背景全体の 3D 化。透過画像、生成画像、裸像を含む人物写真は入力可能とする。
- サーバー保存、アカウント、共有 URL、クラウド GPU。
- Apple SHARP のコード、重み、派生成果物の利用。論文上の一般的な着想のみを独立実装の参考にし、実装を移植しない。
- 写真から FBX 自体を生成すること。FBX は深度プロキシであり、ダウンロード対象は 3DGS である。

## 3. 成功条件

|分類|受け入れ条件（初期値）|
|---|---|
|機能|対応画像を投入して、姿勢プレビュー、3DGS プレビュー、3 形式のダウンロードまでサーバー通信なしで完了する|
|見た目|同梱テスト画像について正面からの pitch / yaw 合成角 25° 以内で前景の主要部位が破綻せず、正面では入力画像との silhouette IoU が 0.85 以上。解像感を維持した上で穴の少なさを優先する|
|姿勢|可視主要関節の再投影誤差の中央値が画像対角の 3% 以下。超過時は UI で警告し手動補正可能|
|性能|指定 PC（Core i7-13650HX、RAM 16 GB、RTX 4060 Laptop 8 GB）で生成 5 分以内、最大 500k splats の viewer を 30 FPS 以上とする|
|容量|最大 500k splats、非圧縮 PLY 100 MB 以下。端末能力により品質 preset と上限を自動調整する|
|プライバシー|生成処理中に画像データをネットワーク送信しない。CSP とテストで保証する|
|互換性|最新安定版 Chrome を正式対応とし、最新の WebGPU 対応スマートフォンは best effort とする|

数値はベンチマーク整備後に端末クラス別へ改訂する。

## 4. リポジトリ内入力資産

- `womenfemale-body-base-rigged.zip` は `source/MujerBaseRigged.fbx` を 1 個含む。ビルド時に展開・検査し、Web 配信用には glTF/GLB へ変換して使用する。元 FBX は原本として保持する。
- `test26.jpeg` と `test29.jpeg` は AI 生成の架空人物であり、E2E / visual regression / 公開 demo に利用できる。test manifest に AI 生成物である旨を記録する。
- FBX の配布ページ上のライセンスは依頼者確認により **CC Attribution（CC BY）** である。商用利用・改変・再配布は可能だが attribution が条件となるため、作者名、ライセンスの版、取得日を公開前に記録する。

FBX をブラウザで毎回直接読む構成を避ける理由は、配信サイズ、パース時間、座標・ボーン命名の差異を build-time に固定できるためである。変換後 GLB には mesh、skin、inverse bind matrices、マテリアル、単位、ボーン対応表の hash を記録する。

## 5. 全体アーキテクチャ

```text
GitHub Actions (offline build lane)
  FBX -> 検証済み GLB + skeleton-map.json
  source models -> ONNX -> INT8/FP16 variants + manifest/hash/license
  TypeScript/Vite -> hashed static assets -> GitHub Pages

Browser (runtime lane; all user data remains local)
  Upload/EXIF normalization
       |
       +-> person detection / pose landmarks ----+
       +-> segmentation mask                     |
       +-> optional monocular relative depth     |
                                                 v
  camera solve -> bone retarget -> body fit -> posed proxy mesh
                                                 |
                     WebGPU G-buffer render <----+
                     depth/normal/id/visibility
                              |
  image + mask + G-buffer -> Gaussian builder -> cleanup/LOD
                              |
               canonical GaussianBuffer (SoA)
                    /                \
          WebGPU viewer          Web Worker exporters
                                PLY / SPLAT / SPZ
```

### 5.1 スレッド分割

- **Main thread**: UI、Three.js scene、入力、進捗、エラー表示。
- **Inference worker**: ONNX Runtime Web または選定ランタイム。`OffscreenCanvas` と WASM threads を利用する。
- **Gaussian worker**: 点生成、sort key、pruning、ファイル encode。転送可能な `ArrayBuffer` を使用する。
- **GPU**: G-buffer、必要なら depth refinement、splat projection/sort/render。

`SharedArrayBuffer` / WASM threads を使う場合は cross-origin isolation が必要だが、GitHub Pages では任意レスポンスヘッダーを付加できない。このため必須要件にせず、通常の Worker + transferable buffer を基準実装にする。将来 COOP/COEP を Service Worker で補う方式は opt-in 実験機能に限定する。

## 6. 技術選定

|領域|第一候補|代替 / 方針|
|---|---|---|
|UI / build|TypeScript + Vite|フレームワークは React または Vanilla を実装開始前に決定|
|3D / FBX・GLB|Three.js、`GLTFLoader`|FBX は CI で GLB 化。ランタイム `FBXLoader` は診断用のみ|
|画像処理|OpenCV.js の必要モジュールだけ custom build|単純処理は Canvas / WebGPU shader とし bundle を抑える|
|推論|ONNX Runtime Web: WebGPU EP 優先、WASM EP fallback|モデル演算の互換表を CI で検証|
|姿勢|商用利用可能な単人人体 landmark モデルを benchmark 後固定|COCO 17 点だけでなく肩・腰・手足・顔基準を含むモデルを優先|
|segment|軽量 person matting / segmentation ONNX|pose mask が十分なら統合モデルを優先|
|splat renderer|自前の薄い WebGPU renderer またはライセンス適合した SPARK.js adapter|SuperSplat はファイル相互運用とデバッグ UX の参照に留め、依存時は license 固定|
|export|canonical buffer から各 encoder を独立実装|SPZ は公式仕様・参照 encoder のライセンス確認後 WASM 化|
|テスト|Vitest + Playwright + shader golden tests|WebGPU software adapter と実 GPU の二層|

Triposplat、SHARP、その他研究実装は、ライセンス・特許・学習データ条件を `THIRD_PARTY_NOTICES.md` と model card で審査してから採否を決める。「公開されている」は「商用利用可能」と同義ではない。

## 7. 処理パイプライン

### 7.1 入力と前処理

1. MIME と magic bytes を検査し、既定 25 MB / 8192 px を上限とする。
2. EXIF orientation を反映後、EXIF/GPS を破棄した RGBA buffer を作る。
3. 長辺 1024〜1536 px の作業画像と、モデル別 letterbox 入力を生成する。
4. 人物 detector で候補を得る。検出がちょうど 1 人なら採用し、0 人または複数人なら要件外として理由を表示して中断する。
5. segmentation / matting で alpha と境界 confidence を得る。入力 alpha があれば尊重し、なければ背景を推定して除去する。背景は 3DGS に含めない。

### 7.2 姿勢推定とカメラ推定

姿勢モデルの出力を `JointObservation {name, x, y, zRelative, visibility, confidence}` に正規化する。左右反転を検査し、低信頼関節は親子制約で補うが、観測値と補間値を区別する。

カメラは初期版では弱透視投影を基本とする。焦点距離を EXIF から得られれば初期値に使い、得られなければ画角 50° 相当から開始する。以下の robust objective を最小化する。

```text
E = w2d * Σ ρ(conf_j * ||project(T * J_j) - p_j||²)
  + wlim * joint_limit_penalty
  + wsym * body_symmetry_penalty
  + wprior * pose_and_shape_prior
```

最適化変数は root translation / rotation、camera scale/focal、各ボーン local quaternion、許可した体型 scale（身長、肩幅、腰幅、四肢長）である。WebGPU compute または WASM の Levenberg–Marquardt で 2 段階（胴体→全身）最適化し、関節 limit と quaternion 正規化を毎 iteration 適用する。

### 7.3 FBX スケルトンのリターゲット

CI の asset inspection でボーン階層、bind pose、単位、up/front axis、skin weight、非一様 scale を検査し、`skeleton-map.json` を生成する。

1. hips を root として T-pose / A-pose の rest directions を記録する。
2. 観測 landmark から target direction を作る。
3. `qLocal = inverse(qParentWorld) * qTargetWorld * qRestCorrection` で local rotation を求める。
4. twist が観測不能な前腕・上腕・大腿等は rest twist を保ち、可動域 clamp を行う。
5. 指、表情、衣服、髪は初期版では推定しない。
6. 画面上に skeleton と keypoint handles を重ね、誤推定をドラッグ修正できるようにする。

素体は女性固定であり、性別不一致への対応は行わない。身長、肩幅、胸郭、腰幅、胴長、腕・脚の太さと長さを安全な範囲で変更する体型 slider を設けるが、写真の体型や衣服を忠実に表すものではない。深度の滑らかな proxy としてのみ使い、姿勢と体型を GLB の 3D preview で確定してから深度生成へ進む。

### 7.4 深度生成と融合

ポーズ済み mesh を入力画像と同じ camera で offscreen G-buffer に描画し、以下を float texture に得る。

- linear view-space depth（メートル換算値と normalized 値）
- world/view normal
- triangle / body-part ID
- front/back facing、visibility、barycentric coordinate

輪郭外は depth invalid とする。segmentation と mesh silhouette のズレは、輪郭近傍に joint-aware guided propagation を適用する。髪・スカート等、素体から離れる領域には optional monocular depth の相対変化を融合する。

```text
d_final = alignScaleBias(d_mono, d_proxy) * c_mono
        + d_proxy                         * c_proxy
        -------------------------------------------
                         c_mono + c_proxy
```

proxy が見える胴体・四肢では proxy を強くし、髪・衣服境界では mono depth を強くする。絶対 scale は仮想身長（既定 1.65 m）により定義する。深度の穴・不連続は confidence として保持し、過剰な blur で隠さない。

### 7.5 Gaussian 生成

初期版は単眼画像を大量 iteration で学習する方式ではなく、depth-assisted deterministic initialization を採る。

1. alpha、色勾配、深度勾配に応じて pixels を importance sample する。
2. 各 sample `(u,v,d)` を camera intrinsics で 3D へ unproject する。
3. Gaussian 中心を表面上に置き、rotation は法線を主軸にした quaternion とする。
4. 接平面方向 scale は隣接 sample 間隔、法線方向 scale はその 0.1〜0.3 倍とする。
5. 色は linear RGB で保持し、SH degree 0（DC）のみを標準にする。単眼から未観測 view-dependent SH を捏造しない。
6. opacity は alpha × segmentation confidence × depth confidence × visibility から求める。
7. 輪郭には小さい splat を多めに、内部の平坦領域には大きい splat を少なめに配置する。
8. 背面の穴を目立たせないため、奥向きの薄い「殻」を silhouette 内にだけ生成可能にする。ただし入力色を引き伸ばした推測データとして flag を付け、既定の許容 view を超えると fade する。
9. voxel dedup、低 opacity prune、異常 scale clamp を行い LOD を作る。

品質保証範囲は `sqrt(pitch² + yaw²) <= 25°` とする。ただし camera orbit は hard clamp せず 360° 操作でき、範囲外では常時警告 overlay と角度メーターを表示する。境界付近から推測殻の opacity と背景を滑らかに調整し、裏側を正しい復元と誤認させない。

### 7.6 任意の短時間 refinement

高性能 WebGPU 端末のみ、入力 view に再投影した differentiable splatting 相当の loss で position / scale / opacity / DC color を 50〜200 step 微調整するモードを検討する。NaN、発散、メモリ超過時は deterministic initialization に戻す。これは MVP の必須条件ではない。

## 8. Canonical Gaussian データモデル

内部表現は Structure of Arrays とし、形式固有の量子化を viewer の状態から分離する。

```ts
interface GaussianBuffer {
  count: number;
  position: Float32Array;    // xyz, world meter
  scale: Float32Array;       // xyz, positive linear scale
  rotation: Float32Array;    // normalized xyzw quaternion
  color: Uint8Array;         // sRGB rgba preview/export source
  shDC: Float32Array;        // RGB DC coefficient, linear
  opacity: Float32Array;     // [0, 1]
  depth: Float32Array;       // source camera linear depth
  normal: Float32Array;      // xyz
  confidence: Float32Array;  // [0, 1]
  sourceUV: Uint16Array;     // normalized UV, debug
  partId: Uint8Array;
  flags: Uint8Array;         // observed/inpainted/shell/boundary
}
```

`depth`、`normal`、`confidence`、`partId` 等は標準 `.splat` / `.spz` が保持できない場合がある。ブラウザ内部と拡張 PLY では保持し、lossy export の前に UI で失われる属性を明示する。将来の再編集用には全情報を保持する独自 `.ccgs` bundle を別提案とし、今回の必須形式には含めない。

## 9. Viewer 設計

### 9.1 基本操作

- orbit は 360°、zoom / pan は安全範囲で操作可能とする。正面からの pitch / yaw 合成角 25° を超えると品質保証範囲外の警告を常時表示する。
- Reset、正面、wire/skeleton overlay、背景色、FOV、point budget、LOD を提供する。
- FPS、visible/total splat、GPU memory 推定、sort/render 時間を HUD に表示する。
- 最新安定版 Chrome + WebGPU を正式環境とする。非対応ブラウザでは起動時に要件と診断情報を表示し、品質保証しない。

### 9.2 デバッグ表示

`RenderMode` を shader uniform で切り替え、同一 buffer を再 upload しない。

|モード|表示|
|---|---|
|Composite|通常の色 × opacity|
|Color only|opacity を固定し色情報だけ表示|
|Depth only|camera depth または source depth を選択し、near/far を histogram で正規化|
|Opacity|0→1 の heatmap|
|Scale|最大軸、最小軸、anisotropy のいずれか|
|Rotation / normal|方向を RGB に map|
|Confidence|推定信頼度の heatmap|
|Part ID|頭・胴・左右腕・左右脚等を categorical color|
|Provenance|observed / propagated / synthetic shell / boundary|
|Overdraw|pixel あたり contribution 数|

さらに min/max depth、opacity、scale、confidence、part、flag、screen-space radius で filter し、invert と isolate を可能にする。「色情報のみ」は幾何を無効化する意味ではなく、位置は描画に必要なので色以外の可視化寄与を固定する、と UI tooltip に記載する。任意 splat を pick し全属性を inspector に表示する。

### 9.3 レンダリング

WebGPU compute で frustum / size culling と depth key 作成を行い、radix sort または tile binning 後、premultiplied alpha で back-to-front 合成する。camera 移動時だけ sort を更新し、停止時は高品質モードに切り替える。GPU limits に応じて chunk upload と LOD を選ぶ。全 shader に bounds check を実装する。

## 10. ファイル出力

### 10.1 PLY

- little-endian binary PLY を既定とする。
- 一般的な 3DGS property（position、scale、rotation、opacity、`f_dc_*`）と、SuperSplat が未知 property を無視して読み込めることを fixture で確認した追加 property（depth、normal、confidence、part/flags）を出力する。
- opacity が logit、scale が log-space、SH DC が規約変換を必要とする実装があるため、SuperSplat の golden file で検証する。

### 10.2 SPLAT

- 実装開始時に上流の現行 reader/write実装を commit SHA で固定し、32-byte/record 系 layout を互換ターゲットとして、position float32、scale float32、RGBA uint8、quaternion uint8 の順序・quaternion component order を fixture で検証する。
- metadata を格納できないため、depth 等が失われることを警告する。

### 10.3 SPZ

- Niantic Labs `spz` の実装開始時点の最新 tagged release（tag がなければ監査済み commit SHA）を lockfile、manifest、metadata に固定し、公式 MIT-licensed encoder を WASM worker で実行する。
- SH degree 0 を標準とし、座標系、quaternion、opacity、color transform を round-trip test する。
- encoder の再配布ライセンスが要件に合わない場合、SPZ は公開できないため blocker とする。拡張子だけ SPZ の別形式を作ってはならない。

ファイル名は `<input-stem>-posed-<UTC timestamp>.<ext>`。`Blob` と object URL で保存し、終了時に revoke する。大容量時は Streams API / File System Access API を progressive enhancement として使う。

## 11. UI / UX フロー

1. **Landing / privacy**: 処理がローカルであること、Chrome/WebGPU の対応環境、モデル容量、入力物の権利と適法・公序良俗に反しない利用が利用者責任であることを表示。
2. **Upload**: drag & drop、ファイル chooser、画像品質検査。
3. **Subject**: 単一人物の検査、crop と背景除去 preview。複数人物は受け付けない。
4. **Pose**: keypoint / skeleton / GLB mesh 3D preview、信頼度警告、左右反転、関節手動補正、体型 slider、やり直し。
5. **Build**: stage 別 progress、キャンセル、品質 preset（Fast / Balanced / High）。
6. **Inspect**: viewer、debug modes、filters、before/after split。
7. **Export**: 形式、互換性、失われる属性、推定サイズを提示して保存。

エラーは「WebGPU 不可」「モデル取得失敗」「人物なし」「複数人物」「メモリ不足」「姿勢低信頼」「export 不可」に分類し、復旧操作を併記する。処理中断時は worker と GPU resources を必ず解放する。

## 12. モデル変換・量子化

モデルを Actions の都度インターネットから latest 取得しない。上流 URL、commit / version、SHA-256、license、input normalization、output schema を `models/manifest.source.json` に固定する。

```text
model-source (manually reviewed / immutable hash)
  -> ONNX export / opset normalization
  -> graph simplify (numerical comparison)
  -> calibration dataset (consent/license reviewed)
  -> static INT8 QDQ for WASM where supported
  -> FP16 weights/graph for WebGPU where beneficial
  -> browser smoke + accuracy regression
  -> public/models/<name>/<hash>/* + manifest.json
```

量子化は一律 INT8 にしない。pose の heatmap / coordinate head など精度劣化が大きい node は FP16/FP32 を維持する mixed precision とする。元モデルに対し以下を gate にする。

- keypoint OKS / PCK の低下 2% 以内
- mask IoU の低下 1.5% 以内
- depth ordinal accuracy / edge metric の定義済み閾値以内
- Chrome WebGPU と WASM の出力差分が tolerance 内
- 全成果物の license allowlist 合格、hash / SBOM / model card 生成

公開 release job と重い model build job を分ける。モデル build は toolchain image digest と lockfile を固定し、既存 hash の artifact を release が取得する。ライセンス不明の calibration 写真を commit しない。

## 13. GitHub Actions / Pages

推奨 workflow:

1. **`ci.yml`**（PR）: format、lint、typecheck、unit、model manifest/license validation、GLB skeleton validation、build、Playwright。
2. **`models.yml`**（手動 / model source 変更時）: 変換、量子化、精度 gate、hash、artifact / release asset 作成。fork PR では secrets を渡さず実行しない。
3. **`pages.yml`**（`main` push / 手動）: 固定 artifact を検証し、base path を repository 名に設定して build、Pages artifact upload、deploy environment 経由で公開。

必要設定:

- `permissions: contents: read` を既定とし、Pages job のみ `pages: write`, `id-token: write`。
- Actions は full commit SHA へ pin。npm / Python / Rust 等の lockfile を commit。
- GitHub Pages project site の subpath で worker、WASM、model URL が壊れないよう `import.meta.env.BASE_URL` から解決。
- SPA fallback に依存せず、静的 `index.html` で成立させる。
- model/WASM に immutable hash file name を使い cache-first。manifest / HTML は短い cache を想定。
- browser が必要とする WASM MIME を検証する。大容量 asset の Pages / Git 上限を超える場合は GitHub Releases/CDN 採用の可否を確認する。
- preview deployment では実写テスト画像を公開 artifact に含めない。

## 14. セキュリティ、プライバシー、法務

- 画像は `createImageBitmap` / Canvas で decode し、SVG、HTML、任意 URL を入力として受けない。
- 解析結果を IndexedDB に保存するのは利用者が明示した場合だけ。reload / tab close で既定削除する。
- telemetry は既定なし。導入する場合も画像、keypoints、生成物、ファイル名を送らず opt-in とする。
- CSP は `default-src 'self'` を基本とし、model 取得元も self に限定する。外部 font / analytics を使わない。
- Dependency review、CodeQL、lockfile audit、SBOM、ライセンス allowlist を CI に置く。
- モデル、FBX、テスト写真、encoder、renderer のライセンスを別々に審査する。商用利用予定が未定でも商用利用可能な構成を既定とする。
- 人物写真の同意、未成年、センシティブ画像、肖像権に関する利用規約・削除方針を公開前に法務確認する。
- 出力に「単眼から推定・補間された 3D」である旨と生成条件を metadata / UI に表示する。

## 15. テスト計画と実装順序

### 15.1 テスト

- **Unit**: 座標変換、quaternion、camera projection/unprojection、bone mapping、depth fusion、各 encoder。
- **Golden**: canonical 3 splats を各形式へ encode/decode し、位置・色・scale・rotation の tolerance を確認。
- **Asset**: FBX/GLB のボーン階層、bind pose、vertex/weight count、axis、license file。
- **Model**: float / quantized の精度比較、WebGPU/WASM parity、破損 download / cache fallback。
- **Rendering**: 既知 camera で depth/normal、filter mode、yaw/pitch clamp の image diff。
- **E2E**: upload→pose correction→generate→filter→3 downloads、cancel、OOM simulation、WebGPU unavailable。
- **Privacy**: E2E 中の request allowlist を記録し、画像 upload がないことを assert。
- **Compatibility**: Chrome 実機、Windows の指定 PC と、最新 Chrome/WebGPU 対応 Android の代表 GPU。
- **Accessibility**: keyboard 操作、focus、ARIA、contrast、色覚に依存しない heatmap legend。

評価データは、正面 / 斜め、全身 / 半身、腕の交差、ゆったりした衣服、長髪、肌色・体型・補助具の多様性を含める。顔の同一性評価を精度指標に使わない。

### 15.2 実装フェーズ

|Phase|成果物|Exit criteria|
|---|---|---|
|0: Spike|FBX inspection、モデル/renderer/export license matrix、WebGPU device probe|法務 blocker 解消、1 test image の depth render|
|1: Pose MVP|upload、single-person pose/mask、GLB retarget、3D preview、体型 slider/manual correction|再投影誤差と姿勢保存がテスト可能|
|2: 3DGS MVP|proxy depth、deterministic Gaussian builder、WebGPU viewer|正面と ±15° の acceptance fixture 合格|
|3: Debug/export|全表示 filter、picker、PLY/SPLAT/SPZ encoder|3 target viewers で round trip 合格|
|4: Optimize|worker、LOD、model quantization、cache、fallback|性能 budget / accuracy gate 合格|
|5: Release|security/privacy/accessibility、Pages workflow、docs|公開 checklist と rollback を確認|

## 16. 確定要件、調査結果、残確認事項

### 16.1 確定したプロダクト要件

- 一般公開と商用利用が可能なライセンス構成に限定する。Apple SHARP は思想・論文上の比較だけを参考にし、コード、weights、output を利用しない。
- 全身、膝上、上半身の写真を受け付ける。人物は厳密に 1 人だけとし、複数人物の選択 UI は作らない。
- 背景は除去する。入力済み alpha は保持する。写真と生成画像は受け付け、イラストは対象外とする。顔は加工せず入力どおり利用する。
- コンテンツをサーバーへ送らず自動モデレーションもしない。入力物の権利、適法性、公序良俗に反しない利用は利用者責任である旨を同意画面に示す。未成年らしさ等の属性をモデルで推定しない。
- `test26.jpeg` と `test29.jpeg` は AI 生成の架空人物として CI、visual regression、公開 demo に利用可能。ただし provenance を README / test manifest に明記する。
- 品質保証視点は pitch / yaw の合成角 25° 以内。viewer は警告付きで 360° 表示できる。自己遮蔽部の推測殻を許容する。
- 軽量 monocular depth を素体 depth と融合し、正面解像感を維持した上で穴の少なさを優先する。仮想身長は 1.65 m。
- 姿勢関節の手動修正と体型 slider、適用結果を確認する GLB 3D preview を必須とする。性別不一致への特別対応や別リグ plugin は今回行わない。
- viewer は 30 FPS、最大 500,000 splats、生成 5 分以内、非圧縮 PLY 100 MB 以下を受け入れ基準とする。基準 PC は Core i7-13650HX / RAM 16 GB / RTX 4060 Laptop 8 GB。
- 保存、再読込、共有 URL、batch、PWA、telemetry は不要で、セッション限りとする。
- UI は日本語のみ、WCAG 2.2 AA と Material 3 Expressive に準拠する。色だけに依存しない状態表示、reduced motion、keyboard操作、十分な target size をコンポーネント受け入れ条件に含める。

### 16.2 資産・ライセンス調査

#### 同梱 FBX

指定された配布元は Sketchfab の [Women/Female body base rigged](https://sketchfab.com/3d-models/womenfemale-body-base-rigged-45caea510e4b4b65bf4ef9bbb4d2045c) であり、依頼者がページ上のライセンス表示を **CC Attribution（CC BY）** と確認した。CC BY は attribution を条件に商用利用、改変、再配布が可能なので、FBX から変換した GLB を GitHub Pages で配信する本用途にも採用できる。

ただし、リポジトリの ZIP には FBX しかなく、license file、作者名、CC BY の版、取得日時、原 URL の記録がない。また本設計更新時の実行環境から Sketchfab のページ/API は HTTP 403 となり、作者名とライセンス版を独立確認できなかった。ライセンス種別は確定済みとし、正しい attribution を欠いたまま公開しないため Phase 0 で次を必須 gate とする。

1. 配布ページの作者表示、正確な CC BY の版、ページの PDF または screenshot、取得日、model UID を `docs/licenses/fbx/` に保存する。
2. 作者名、作品名、原 URL、該当する CC BY ライセンス URL、FBX から GLB へ変換・最適化した旨を、アプリのライセンス画面、README、`THIRD_PARTY_NOTICES.md` に明瞭に表示する。作者が指定した attribution 表記があればそれを優先する。
3. GLB 内の `asset.extras` にも source URL、license identifier、creator、modification notice を格納し、ダウンロードまたはキャッシュされた asset から由来を追跡できるようにする。
4. CI の `asset-license.json` に SPDX ID（正確な版の確定後は例として `CC-BY-4.0`）、source SHA-256、creator、source URL、license URL、証跡 path がない場合は Pages build を失敗させる。

以上の attribution gate が通れば mesh / texture を公開 GLB bundle に含め、利用者へ直接 preview してよい。スケルトン仕様はないため、CI の解析結果と versioned mapping を正とする。将来、配布ページの表示が CC BY ではなかったことが判明した場合だけ公開を停止し、商用再配布可能な代替 asset または自作 asset に置き換える。

#### SPZ と参考実装

Niantic Labs の公式 [`nianticlabs/spz`](https://github.com/nianticlabs/spz) は MIT License で、C++ encoder/decoder と Emscripten による TypeScript/WASM build 手順を提供する。実装時には「latest」を毎回追わず、最新安定 tag または監査した commit SHA を固定する。同実装は既定 RUB（Right, Up, Back）等の named coordinate system と変換 API を持つため、canonical 座標から明示変換して round-trip test する。

Three.js、OpenCV.js、SPARK.js、SuperSplat、Triposplat は必須依存ではない。精度、GPU compatibility、bundle size、商用ライセンスを benchmark して必要最小限だけを採用する。PLY の互換基準は SuperSplat とし、独自 debug property を追加しても正常に読み込めることを実際の pinned version で検証する。

### 16.3 出力座標系

依頼者指定の外部座標を **+X = 右、-Y = 上、+Z = 正面** と定義する。これは通常の「Y-up」という略記では誤解を招くため、内部 enum を `RDF`（Right, Down, Front: +X right / +Y down / +Z front）とし、「上方向 vector は `(0,-1,0)`」を metadata に明記する。

Three.js/GLB および SPZ の慣用座標とは異なるため、内部演算は右手系の単一 canonical frame に固定し、入出力境界で position、normal、quaternion、SH をまとめて変換する。負 determinant の単純な 1 軸反転を quaternion に直接適用せず、rotation matrix を介して再直交化する。各 PLY/SPLAT/SPZ fixture に右・上・正面の非対称 marker を置いて mirror / upside-down を検出する。

### 16.4 配信とモデル取得

- 正式対応は最新安定版 Chrome + WebGPU。最新 WebGPU 対応 smartphone は best effort とし、device limits と推定メモリから品質 preset を下げる。
- GitHub Pages は project site、custom domain なし。`BASE_URL=/<repository>/` を E2E で検証する。
- npm package、モデル、WASM、runtime asset は Actions build 時に外部から取得して hash を検証し、Pages artifact に自己完結させる。利用者の実行時通信先は同一 Pages origin のみとする。
- 「一般的なブラウザゲーム相当」は検証可能な数値ではないため、初期 performance budget を **初回転送合計 250 MB 以下、単一 model 100 MB 以下、gzip/brotli 後 JS 10 MB 以下** と仮置きする。accuracy benchmark と Pages の制限を測定して変更する場合は ADR に残す。大きな model は interaction 後に段階取得し、Cache Storage へ保存する。
- 推論モデルは商用利用可能なものだけを採用し、精度を最優先に WebGPU 実測比較する。Actions は固定 URL から pretrained weights を取得可能だが SHA-256 と license gate を必須とする。量子化 calibration には権利確認済みの repository test images を利用する。

### 16.5 GitHub Pages の private / 閲覧制限に関する回答

GitHub の公式ドキュメントによると、GitHub Free の Pages は public repository で利用でき、private repository からの公開は GitHub Pro / Team 等の対象 plan が必要である。ただし **private repository から deploy できることと、公開サイトへのアクセス制限は別問題** である。GitHub Pages の private publishing / access control は Enterprise Cloud の organization site 等、対象条件に依存するため、無課金 GitHub Pages だけで「private repository + 認証付き非公開 Pages」を満たす構成としては採用しない。

選択肢は次のとおり。

1. **今回の既定**: public repository + public GitHub Pages。画像処理は端末内のみで、secret を置かない。
2. source を private にするだけなら有料 GitHub Pro 等を契約して Pages を public deploy する。ただしサイト自体は非公開にならない。
3. 無料かつ閲覧制限が必須なら GitHub Pages 要件を外し、認証/access policy を提供する別 hosting を比較する。この場合も build artifact は静的なままにできるが、外部サービスの利用規約・上限・通信要件を別途承認する。

根拠は GitHub 公式 [About GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/about-github-pages) と [Changing the visibility of your GitHub Pages site](https://docs.github.com/en/pages/getting-started-with-github-pages/changing-the-visibility-of-your-github-pages-site) を release 前に再確認する。現時点の要求に従い、追加費用なしなら選択肢 1 を設計 baseline とする。

### 16.6 評価と納品

Apple SHARP の出力と同じ入力を目視比較し、依頼者が限定視点の立体感を評価する。ただし SHARP の output を学習、変換、再配布には使わない。主観比較に加え、silhouette IoU、再投影誤差、穴率、temporal orbit capture の flicker、生成時間、FPS、VRAM、出力容量を記録して退行を判断する。

納品範囲は source、モデルと provenance/model cards、量子化 Actions、GitHub Pages workflow、操作説明、設計、試験記録、license/SBOM のすべてとする。Codex Cloud に GPU がないことを想定し、unit/format test と software rendering は CI、実 GPU acceptance は依頼者 PC で実施できる診断ページと結果 JSON download を提供する。

### 16.7 残確認事項

質問 17（背景色、crop、alpha feather 等）には回答がなかったため、実装を止めない暫定仕様を採る。

- crop は人物 bounding box + 10% margin の自動 crop とし、利用者が矩形を微調整できる。
- alpha feather は 0〜8 px、既定 2 px の slider を設ける。
- viewer 背景色は light / dark / checkerboard と任意色を選べるが、出力 3DGS に背景 splat は含めない。

この暫定仕様に異論がある場合だけ、実装前に希望値を指定する。

## 17. 初期の重要判断

実装前に最初に確定すべき順序は次のとおりである。

1. CC BY の作者名と正確な版を含むライセンス証跡を取得し、必須 attribution を実装・CI gate 化する。
2. SuperSplat、現行 SPLAT layout、固定 SPZ revision の round-trip fixtures。
3. 指定 PC と Chrome で model candidates、500k splats、5分/30 FPS/100 MB budget を実測する。
4. 全身・膝上・上半身の各 fixture で、背景除去と推測殻の品質を比較する。
5. AI生成テスト写真の provenance と acceptance dataset manifest を整備する。

これらが確定すれば、Phase 0 で技術 feasibility を測定し、結果に基づいてモデルと renderer を固定する。特に「単眼 1 枚」「ブラウザのみ」「背面なし」という制約下では、3DGS の名称だけで全周 neural reconstruction を期待させず、**ポーズ済み人体 proxy に沿って入力画素を立体配置する限定視点 representation** として品質を定義することが、実装可能性と利用者期待を一致させる鍵となる。

## 18. 人体再構成への実装改訂

初期MVPの画像全体に楕円形のdepthを与える方式は人体再構成ではないため廃止する。人物推定結果なしのfallbackも禁止し、0人・複数人・maskなし・不完全な骨格ではfail closedとする。

現在のPhase 1では、MediaPipeの33点骨格とsegmentation maskを同時に推定する。背景画素はsplat候補に含めない。maskの境界距離場から局所的な身体半径を求め、骨格線分で補間したzを中心面とし、前面・中間・背面の三層から閉じた人体proxyを作る。これにより写真全体を一様に曲げず、入力人物のsilhouetteと姿勢を保持する。

次のPhase 2では同梱FBXをGLBへ変換し、33点からボーンへretargetしたskinned meshのdepth/normal G-bufferで現在の距離場priorを置き換える。Phase 3では商用利用可能な単眼depthをWebGPUで推論し、顔・髪・衣服のdetailは単眼depth、関節・遮蔽・背面はrig depthを優先して融合する。

リポジトリのSHARP出力は最終品質の目視比較資料とし、学習・変換・アプリ配信には使わない。合格条件は背景splat数0、splat上限遵守、骨長比維持、silhouette IoU、25度orbitでの穴率、およびSHARP出力との同一入力比較とする。

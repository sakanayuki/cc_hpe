# PoseSplat Studio

人物写真を端末内で奥行き付き Gaussian cloud に変換し、ブラウザで確認・書き出しする GitHub Pages 向けアプリです。

## 実装済みの処理

- MediaPipe（ローカル配信したWASM/model）による単一人物検出、33点3D姿勢推定、人物segmentation。背景画素は出力しません。
- 写真上への推定骨格overlayと、信頼度の表示。推定していないように見える状態を避け、入力と推定結果を直接照合できます。
- **STEP 1**: 同梱FBXからbuildしたGLBへ、腰・背骨・胸・首・頭・肩・腕・手・脚・足の19部位を階層順にretarget。GLB上に骨とクリック可能な関節を表示します。
- 選択関節のXYZ回転、姿勢の奥行き、体幅・身長比・腕長・脚長、関節単位/全体reset、正面・側面・背面・上面viewを備えた姿勢editor。
- **STEP 2**: 編集後のskinned GLBをoffscreen描画したdepth、人物mask、3D骨格depth、silhouette距離場を融合し、前面・中間・推定背面から人体cloudを生成。
- 最大500,000 splats、covariance投影するanisotropic Gaussian viewer、実測FPS、25°品質警告、カラー・深度・opacity・confidence・生成層debug表示およびconfidence/生成層フィルター。
- SuperSplat/Graphdeco互換binary PLY（debug属性付き）、32-byte SPLAT、Niantic SPZ v3（degree 0 SH）の保存。
- TypeScript unit tests、hash固定runtime asset、GitHub Pages build/deploy workflow。

単眼写真から観測できない背面を正確に復元することはできません。背面は補正済みrigとsilhouetteから推測し、品質保証範囲を正面から合成角25°以内に限定しています。SHARPの学習済み出力を複製するものではなく、商用利用可能な構成だけで再構成する実装です。

## 開発

```bash
npm ci
npm run dev
npm run typecheck
npm test
npm run build
npm run verify:pages
```

設計と段階的な完了条件は [`DESIGN.md`](./DESIGN.md) を参照してください。

## GitHub Pagesへの公開

リポジトリの **Settings → Pages → Build and deployment → Source** を `GitHub Actions` に設定し、`main` へpushすると [Pages workflow](./.github/workflows/pages.yml) が型検査、テスト、build、Pages用base path検査を行ってから公開します。Actions画面の **Deploy Pages → Run workflow** から手動実行することもできます。

生成完了時には処理秒数とPLY推定容量、Viewerには実測FPSを表示します。カメラ操作終了時には65,536段階のstable counting sortでGaussianを遠方から手前へ並べ直し、source-over alpha合成の順序を維持します。

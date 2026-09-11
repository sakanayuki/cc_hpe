# PoseSplat Studio

人物写真を端末内で奥行き付き Gaussian cloud に変換し、ブラウザで確認・書き出しする GitHub Pages 向けアプリです。

## 現在の実装範囲（Phase 0 / viewer MVP）

- JPEG / PNG / WebP のローカル読み込み（25 MB 以下）
- MediaPipeによる単一人物検出、33点姿勢推定、人物segmentation
- 背景画素を完全除外し、骨格とsilhouetteに沿う前面・中間・背面の人体proxy生成
- 最大 500,000 splats、奥行き量の調整
- 360° orbit viewer と、25°を超えた際の品質警告
- カラー、深度、不透明度、信頼度のデバッグ表示
- debug properties 付き binary PLY、32-byte SPLAT のローカル出力
- TypeScript unit tests、GitHub Pages build/deploy workflows

楕円柱状の旧方式は廃止しました。現在は人物推定に成功しない限り生成しません。FBX/GLBリターゲット、単眼depthモデル、WebGPU splat renderer、SPZ WASM encoderは後続フェーズです。現段階はSHARP相当の最終品質ではなく、骨格を保持した閉じた人体proxyです。

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

# Letta session context

- project: issue-210-pre-run-observation
- branch: issue-210-pre-run-observation
- retrieved_at: 2026-09-28T03:01:44.895Z

## User

- 会話は日本語。PRコメント・コミット・公開docsは英語。
- **コミット/PRに `Co-Authored-By` を絶対に付けない。**
- 読み取り専用と言われたら厳守 — 前後で `git status` を確認して報告。
- 簡潔・命令形のプロンプト。自明な確認ダイアログは挟まない。
- レビュー/セキュリティ指摘は重大度でレベル分けして英語で。
- 最新 `main` から worktree を切って作業し、PR まで出す。大きい範囲は事前に Issue 化。
- 変更後は tests + lint + typecheck + 主要 CLI フローを実際に実行して確認。
- 並行 worktree の成果物は参照しない（実験を混ぜない）。
- 複雑なら `/architecture-planning`、単純なら `/poteto-mode`。

## Project constraints

- 設計6原則: 無汚染 / 再現可能 / ランタイム非依存の核 / 透過的 / 小さく合成可能 / 安全側に失敗。
- 分離の正しさは検証する前提で扱う — `CLAUDE_CONFIG_DIR` は `~/.claude/CLAUDE.md` を完全には隔離しない既知の穴がある。
- セキュリティ最優先の repo。ローカルの機微ファイルを操作し、プロンプトインジェクションが主要脅威。Gitleaks CI と CI 失敗時の read-only 調査が回っている。
- 1.0.0 で公開済み(MIT)、安定面は major version が保護。`docs/contract.md` が 1.0 の拘束契約、credential-bridge フラグは実験的のまま。
- 下位レイヤに限定 — eval/UI は持たない。ROI Tracker は上位。
- フレームワーク/重量依存を安易に足さない。抽象化は目的ではない。ユーザー向け挙動は原則変えない。runtime 固有ロジックは adapter に閉じる。
- テストは `*.test.ts` をソース隣に置く。

## Open questions

- クロスランタイム自動移植とローカルLLM対応は v0.3 では Future Plan（現行実装の前提外）。
- `pfl`（静的検査）と yuurei（実行隔離）を突き合わせる Analyzer はまだ未来の話。

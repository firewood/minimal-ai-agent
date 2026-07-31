# minimal-ai-agent

雑誌記事「**エージェント自作で学ぶLLMの組み込み方**」の解説用リポジトリ。

Cloudflare Agents SDK + Gemini API + Slack + Google Calendar で、
「先回りして動く個人アシスタント Agent」を **約 800 行**で作る。

## このリポジトリの読み方

**`git log` が記事の目次になっている。** 古い commit から順に、記事の各節に対応した
1 つの概念だけを足していく。

```bash
git log --oneline --reverse
```

まず [CONCEPT.md](./CONCEPT.md) を読む。設計判断（何を LLM に任せ、何をコードで制御するか）が
そこに全部書いてある。そのあと commit を順に追うと、その設計がコードとして立ち上がっていく。

各 commit は単体で型チェックが通るので、`git checkout <commit>` して読み進められる。

---

セットアップ手順は最後の commit で追加する。

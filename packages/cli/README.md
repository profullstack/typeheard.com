# @profullstack/typeheard

Transcribe audio and video from the terminal with [typeheard.com](https://typeheard.com).

```sh
curl -fsSL https://typeheard.com/install.sh | sh
```

Or with npm (Node >= 22.6): `npm i -g @profullstack/typeheard`, or run it once with
`npx -y @profullstack/typeheard <file>`.

```sh
typeheard interview.m4a                    # prints the text
typeheard talk.mp4 --format srt --out talk.srt
typeheard login                            # API key for whole files
typeheard tui                              # your transcripts, in the terminal
```

Without a key you get the first few minutes of any file free. `TYPEHEARD_API_KEY` and
`TYPEHEARD_URL` override the saved config. Docs: https://typeheard.com/docs

MIT, Profullstack, Inc.

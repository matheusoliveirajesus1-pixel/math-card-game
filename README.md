# Pilha Matematica Online

Cliente estatico em `index.html` para publicar no GitHub Pages e backend em `server.js` para subir no Render.

## Rodar localmente

1. Instale as dependencias:

```bash
npm install
```

2. Inicie o servidor:

```bash
npm start
```

3. Abra o `index.html` no navegador.
4. No campo `URL do servidor WebSocket`, use:

```text
ws://localhost:3000
```

## Publicar no Render

1. Crie um novo `Web Service` apontando para este repositorio.
2. Configure:

```text
Build Command: npm install
Start Command: npm start
```

3. Depois do deploy, copie a URL publica do Render.
4. No `index.html` publicado no GitHub Pages, informe a URL do backend:

```text
wss://seu-backend.onrender.com
```

## Publicar no GitHub Pages

1. Suba o projeto para um repositorio no GitHub.
2. Ative o GitHub Pages servindo a branch principal.
3. Abra a URL publicada.
4. Passe a URL `wss://...` do Render para os jogadores junto com o codigo da sala.

## Fluxo

- O host cria a sala, escolhe 2 a 4 jogadores e compartilha o codigo.
- Os outros entram com nome e codigo.
- O host inicia a partida.
- O servidor valida turnos, cartas, respostas, pontuacao e fim de jogo.

# Configuração (para quem não é developer)

Faz estes passos por ordem. Nunca envies a chave privada a ninguém, nem a mim:
ela só se cola nas definições do sítio onde a app corre.

## 1. Base de dados (Neon, grátis)
1. Cria conta em neon.com e carrega em **New Project** (nome: `perch`, região: Frankfurt).
2. Copia a **Connection string** (começa por `postgresql://`). É o `DATABASE_URL`.

## 2. Carteira do keeper (só para isto)
1. Na tua carteira (MetaMask ou Rabby) cria uma conta **nova**, chamada `Perch keeper`.
   Não uses para mais nada.
2. Copia o **endereço** (público, pode ser partilhado) e envia-lhe **0,01 ETH** na Robinhood Chain,
   só para gás. Ela não pode levantar dinheiro dos vaults.
3. Exporta a **chave privada** desta conta. É o `KEEPER_PRIVATE_KEY`.

## 3. Segredo do cron
Gera uma palavra-passe longa (32+ caracteres) no teu gestor de palavras-passe. É o `CRON_SECRET`.

## 4. Colar as variáveis no sítio onde a app corre
`DATABASE_URL`, `KEEPER_PRIVATE_KEY`, `CRON_SECRET` e, para o beta fechado,
`ARM_ALLOWLIST` (endereços das carteiras permitidas, separados por vírgula).
Depois volta a publicar a app.

## 5. Agendador (cron-job.org, grátis)
1. Cria conta em cron-job.org e **Create cronjob**.
2. URL: `https://O-TEU-ENDERECO/api/degen/tick`, a cada **1 minuto**.
3. Em **Advanced → Headers** adiciona `Authorization` com o valor `Bearer ` seguido do teu `CRON_SECRET`.

## 6. Verificar
Abre `https://O-TEU-ENDERECO/api/degen/status`. Tem de aparecer `"ok": true` e `"problems": []`.
Se aparecer um problema, a frase diz o que falta.

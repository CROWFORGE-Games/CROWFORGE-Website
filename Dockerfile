FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY index.html ./
COPY leaderboard.html ./
COPY services.html ./
COPY CROWFORGE_Crow.png ./
COPY CROWFORGE_Games.png ./
COPY CROWFORGE_Games_Translucent.png ./
COPY tavern-legends-logo.jpg ./
COPY werewolf-hunter-logo.jpg ./

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["npm", "start"]

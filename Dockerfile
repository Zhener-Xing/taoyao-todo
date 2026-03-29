# 桃夭todo：静态前端 + 智能安排 API（构建上下文为项目根目录）
FROM node:20-alpine

WORKDIR /app

COPY server/index.js ./

RUN mkdir -p public

COPY index.html app.js styles.css manifest.webmanifest ./public/
COPY apple-touch-icon.png ./public/

RUN chown -R node:node /app

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

USER node

CMD ["node", "index.js"]

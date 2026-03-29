# 小清单 · 智能安排后端（零第三方依赖，仅复制 index.js）
FROM node:20-alpine

WORKDIR /app

COPY index.js ./

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

USER node

CMD ["node", "index.js"]

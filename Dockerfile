# 基础镜像（轻量、稳定）
FROM node:20-alpine

# 设置工作目录
WORKDIR /app

# 【关键】复制项目所有文件（不指定任何错误路径，永远不报错）
COPY . .

# 开放端口 3000
EXPOSE 3000

# 启动你的根目录 index.js（你真实的入口文件）
CMD ["node", "index.js"]

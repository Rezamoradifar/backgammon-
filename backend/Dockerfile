# Multi-stage build: compile TypeScript and generate the Prisma client in a
# full node image, then run the compiled output in a slim runtime image.

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npm run build
# tsc only emits compiled .ts->.js output - it has no idea these JSON ABI
# files exist since nothing statically `import`s them (they're loaded at
# runtime via readFileSync), so they need to be copied into dist by hand.
RUN cp -r src/indexer/abi dist/indexer/abi

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY prisma ./prisma
RUN npx prisma generate

COPY --from=build /app/dist ./dist

EXPOSE 4000
# Applies any pending migrations against DATABASE_URL, then starts the server.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]

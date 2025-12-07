# ใช้ Playwright image ที่มี Chromium + lib ระบบครบแล้ว
FROM mcr.microsoft.com/playwright:v1.57.0-jammy

# ตั้ง working directory
WORKDIR /app

# ก็อปเฉพาะไฟล์ package เพื่อให้ใช้ layer cache ในการ install
COPY package*.json ./

# ติดตั้ง dependencies ของโปรเจกต์ (ไม่ต้องเอา devDependencies ขึ้น production ก็ได้)
RUN npm install --omit=dev

# ก็อปซอร์สที่เหลือขึ้นไป
COPY . .

# บอกว่าตัว app ฟัง port 8080 (Railway จะ map ENV PORT มาให้)
EXPOSE 8080

# ตั้งโหมด production
ENV NODE_ENV=production

# คำสั่งเริ่มรันแอป
CMD ["node", "src/server.js"]

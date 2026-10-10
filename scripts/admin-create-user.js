// npm run admin:create-user -- <login> <password> — создание администратора (ТЗ FR-A-020).
// Пароль хешируется bcrypt; в лог попадает только логин.
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { AdminUser } = require('@beauty/shared');

const run = async () => {
  const [login, password] = process.argv.slice(2);
  if (!login || !password) {
    console.error('usage: npm run admin:create-user -- <login> <password>');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('password must be at least 8 characters');
    process.exit(1);
  }

  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is not set');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const passwordHash = await bcrypt.hash(password, 10);
  const result = await AdminUser.updateOne(
    { login },
    { $set: { login, passwordHash } },
    { upsert: true }
  );
  console.log(`admin ${login}: ${result.upsertedId ? 'created' : 'password updated'}`);
  await mongoose.disconnect();
};

run().catch((error) => {
  console.error('admin:create-user failed:', error.message);
  process.exit(1);
});

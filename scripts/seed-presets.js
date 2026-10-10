// npm run seed:presets — upsert каталога пресетов в MongoDB (ТЗ 8.1, Приложение D).
// Запуск на Э3 после создания managed MongoDB: MONGO_URI=... npm run seed:presets
const mongoose = require('mongoose');
const { Preset, PRESETS_CATALOG } = require('@beauty/shared');

const run = async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGO_URI is not set');
    process.exit(1);
  }
  await mongoose.connect(uri);
  for (const preset of PRESETS_CATALOG) {
    await Preset.updateOne(
      { code: preset.code },
      { $set: { ...preset, active: true } },
      { upsert: true }
    );
  }
  console.log(`seed done: ${PRESETS_CATALOG.length} presets upserted`);
  await mongoose.disconnect();
};

run().catch((error) => {
  console.error('seed failed:', error.message);
  process.exit(1);
});

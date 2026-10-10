// In-process очередь генераций (ТЗ Д4, FR-G-090): concurrency-лимитер без внешних зависимостей.
// Интерфейс add(fn) → Promise — при росте нагрузки меняется на BullMQ без правки хендлеров.

class LimiterQueue {
  constructor({ concurrency = 1 } = {}) {
    this.concurrency = Math.max(1, concurrency);
    this.active = 0;
    this.jobs = [];
  }

  add(fn) {
    return new Promise((resolve, reject) => {
      this.jobs.push({ fn, resolve, reject });
      this._drain();
    });
  }

  _drain() {
    while (this.active < this.concurrency && this.jobs.length > 0) {
      const job = this.jobs.shift();
      this.active += 1;
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active -= 1;
          this._drain();
        });
    }
  }

  get size() {
    return this.jobs.length;
  }

  get busy() {
    return this.active > 0;
  }
}

module.exports = {
  LimiterQueue,
};

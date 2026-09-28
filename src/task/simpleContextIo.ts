/**
 * Step 6: `simpleContext` dosya sistemi I/O dikişi (TEST-ONLY seam).
 *
 * Step 5'in `WorkspaceFs` deseniyle aynı disiplin (bkz. Issue #25):
 * production davranış BİREBİR `node:fs/promises`'tır; testler
 * fault-injection I/O enjekte edebilir (errno sınıflandırması — ENOENT
 * ≠ EACCES/EIO/... — deterministik olarak ölçülemez bir gerçek FS
 * hata durumu icat etmeden). `setSimpleContextIo(null)` gerçek dosya
 * sistemini geri koyar. Hiçbir service/server modülü bu seam'i
 * production yolunda KULLANMAZ; seam yalnız `simpleContext`'a aittir.
 */

import { lstat, readFile, readlink } from "node:fs/promises";
import type { Stats } from "node:fs";

export interface SimpleContextIo {
  lstat(target: string): Promise<Stats>;
  readlink(target: string): Promise<string>;
  readFile(target: string): Promise<Buffer>;
}

const realIo: SimpleContextIo = {
  lstat: (target) => lstat(target),
  readlink: (target) => readlink(target),
  readFile: (target) => readFile(target),
};

let current: SimpleContextIo = realIo;

/** Test seam: fault-injection I/O enjekte et; `null` → gerçek dosya sistemi. */
export function setSimpleContextIo(io: SimpleContextIo | null): void {
  current = io === null ? realIo : io;
}

/** Geçerli I/O görünümü (gerçek ya da enjekte edilmiş). */
export function getSimpleContextIo(): SimpleContextIo {
  return current;
}

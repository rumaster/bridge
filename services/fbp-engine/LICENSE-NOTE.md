# License note for fbp-engine (M0 → M3)

Проверка выполнена 2026-07-02 через GitHub metadata для
`https://github.com/rumaster/fbp-engine`.

- Репозиторий: `rumaster/fbp-engine`
- Default branch: `main`
- Лицензия GitHub: MIT License, SPDX `MIT`
- Файл лицензии: `LICENSE`

## M0

Ограничение для этапа M0: upstream-код `fbp-engine` не включался в
`services/fbp-engine`. В каталоге находился только clean-room детерминированный
мок C5 и DTO-валидация для contract-first разработки.

M0 фиксировал требование: перед этапом M3 и включением upstream-кода нужно
отдельным изменением проверить совместимость лицензии, сохранить MIT
license/copyright notices для заимствованных файлов и явно перечислить
импортированные upstream-компоненты в PR.

## M3 — форк как clean-room переработка (ТЗ §13.13)

Движок этапа M3 (`src/core/*`, `src/nodes/*`, `src/transform/*`, `src/schema/*`,
`src/backend/*`, `src/engine.mjs`) — **clean-room реализация**: ни один файл
upstream-проекта `rumaster/fbp-engine` не копировался и не адаптировался
построчно. «Форк» из ТЗ §13.13 трактуется как переработка идеи
Flow-Based Programming (граф Node/Connection, Execution Context, пошаговое
исполнение) в доменно-нейтральное ядро под платформу, а не как импорт исходного
кода.

Следствия для лицензии:

- Заимствованных из upstream файлов нет → сохранять чужие MIT license/copyright
  notices не требуется (нечего атрибутировать построчно).
- Импортированных upstream-компонентов нет → перечислять в PR нечего.
- MIT совместима с проектом; upstream указан как концептуальный источник
  вдохновения (не как источник кода).

Если в будущем (M4+) появится реальный импорт upstream-кода, требование M0
остаётся в силе: отдельным изменением проверить лицензию, сохранить MIT
notices и перечислить импортированные компоненты в PR.

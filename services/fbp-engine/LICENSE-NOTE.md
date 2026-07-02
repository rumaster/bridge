# License note for fbp-engine M0

Проверка выполнена 2026-07-02 через GitHub metadata для
`https://github.com/rumaster/fbp-engine`.

- Репозиторий: `rumaster/fbp-engine`
- Default branch: `main`
- Лицензия GitHub: MIT License, SPDX `MIT`
- Файл лицензии: `LICENSE`

Ограничение для текущего этапа M0: upstream-код `fbp-engine` не включается в
`services/fbp-engine`. В этом каталоге находится только clean-room
детерминированный мок C5 и DTO-валидация для contract-first разработки.

Перед этапом M3 и включением upstream-кода нужно отдельным изменением проверить
совместимость лицензии, сохранить MIT license/copyright notices для заимствованных
файлов и явно перечислить импортированные upstream-компоненты в PR.

# @xnlc/core

XNLC Core — библиотека для запуска Minecraft, включающая разрешение версий, установку загрузчиков (Forge, Fabric, Quilt, NeoForge, OptiFine), управление ассетами и запуск игры.

## Установка

```bash
npm install @xnlc/core
```

## Возможности

- 🎮 Запуск Minecraft (vanilla, Forge, Fabric, Quilt, NeoForge, OptiFine)
- 📦 Автоматическая загрузка и установка загрузчиков
- 🔧 Разрешение версий и зависимостей
- 📥 Управление ассетами и библиотеками
- ☕ Автоматическое определение и установка Java
- 🔐 Поддержка офлайн и Microsoft авторизации

## Использование

```typescript
import { Xnlc } from '@xnlc/core';

const xnlc = new Xnlc({
  gameDir: '/path/to/.minecraft',
});

// Получить поддерживаемые версии
const versions = await xnlc.getOptifineSupportedVersions();

// Установить загрузчик
await xnlc.installLoader('1.20.4', 'forge', '36.2.34');

// Запустить игру
await xnlc.launch(
  { mcVersion: '1.20.4', loaderType: 'forge', loaderVersion: '36.2.34' },
  auth,
  { javaPath: '/usr/bin/java', memoryMax: '4G' }
);
```

## Лицензия

MIT © MAINER4IK

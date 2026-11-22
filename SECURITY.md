# Политика безопасности

## Как сообщить об уязвимости

Пожалуйста, **не создавайте публичный issue**. Сообщите приватно через GitHub: вкладка **Security** → **Report a vulnerability**
([создать сообщение](https://github.com/Oleg4311/multiplayer-kit/security/advisories/new)).

Укажите, что именно не так, как это воспроизвести и какая версия затронута. Я постараюсь ответить в течение недели, но это проект одного человека, поэтому сроки не гарантирую.

## Поддерживаемые версии

Исправления выходят для последней версии: ветка `main` и последний релиз.

## Что считается уязвимостью

Любой способ узнать чужие скрытые данные (расстановку кораблей до конца партии, токен чужого места), сделать ход за другого игрока или недопустимый ход, обойти проверку `Origin`, ограничение частоты или размера сообщений, повредить состояние комнаты, получить доступ к чужой комнате без токена, внедрить HTML через имена игроков.

## Что вне области

Тот факт, что оператор сервера видит все данные (это описано в README), уже известные проблемы в зависимостях (их закрывает Dependabot), массовое создание комнат (защита должна стоять на уровне правил Cloudflare), атаки, требующие физического доступа к устройству, и отчёты без способа воспроизведения.

---

## English

Please report vulnerabilities privately via GitHub Security Advisories (**Security** → **Report a vulnerability**) and do not open a public issue. Include what is wrong, how to reproduce it and which version is affected. This is a one-person project, so response times are best-effort. Only the latest release and `main` receive fixes. In scope: leaking hidden game data or seat tokens, acting for another player, bypassing origin/rate/size checks, corrupting room state. Out of scope: the server operator seeing data (documented), known dependency issues, mass room creation.

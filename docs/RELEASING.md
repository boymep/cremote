# Выпуск версии

Публикация в npm идёт из GitHub Actions при пуше тега `v*` ([release.yml](../.github/workflows/release.yml)).

## Один раз: доверенная публикация

Workflow публикует пакет через trusted publishing (OIDC). Токен npm не нужен.

1. Первую версию опубликуйте вручную, чтобы пакет появился в npm:

   ```sh
   npm login
   npm publish --access public
   ```

2. На npmjs.com откройте пакет `cremote` → Settings → Trusted Publisher → GitHub Actions. Укажите владельца `boymep`, репозиторий `cremote`, файл workflow `release.yml`.
3. Там же в Publishing access включите «Require two-factor authentication and disallow tokens». Тогда публиковать сможет только этот workflow и вы с 2FA.

## Каждый выпуск

1. Убедитесь, что `main` зелёный (workflow CI).
2. Поднимите версию без автоматического тега:

   ```sh
   npm version patch --no-git-tag-version   # или minor / major
   git commit -am "chore: release v$(node -p "require('./package.json').version")"
   ```

3. Поставьте тег и отправьте:

   ```sh
   git tag v$(node -p "require('./package.json').version")
   git push origin main --tags
   ```

4. Workflow проверит, что тег совпадает с версией в `package.json`, соберёт проект, выполнит `npm publish --provenance --access public` и создаст GitHub release с автоматическими заметками.

Если публикация упала, исправьте причину и выпустите следующую версию: номер, ушедший в npm, использовать повторно нельзя.

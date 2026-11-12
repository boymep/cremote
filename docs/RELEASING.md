# Выпуск версии

Публикация в npm идёт из GitHub Actions при пуше тега `v*` ([release.yml](../.github/workflows/release.yml)).

## Один раз: токен npm

1. На npmjs.com создайте Granular Access Token с правом Read and write на пакет `cremote` (для первой публикации — на все пакеты аккаунта, затем сузьте).
2. В репозитории на GitHub: Settings → Secrets and variables → Actions → New repository secret. Имя `NPM_TOKEN`, значение — токен.

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

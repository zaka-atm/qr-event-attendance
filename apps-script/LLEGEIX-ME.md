# Conectar la app de recepción con tu hoja (10 minutos)

La app de recepción (`recepcio/`) lee el QR que ya reciben los asistentes, saca el DNI y pregunta a este Apps Script si la persona puede pasar:

- **No está en «Assistència Pagada»** → rojo, «No consta a la llista de pagaments».
- **Ya está en «Assistència»** → rojo, con la hora a la que entró.
- **Todo correcto** → verde, y añade la fila en «Assistència» (fecha, nombre, DNI, número y tipo: columnas A–E, como siempre).

Es un proyecto **nuevo**: tu «Script QR's Project» y el envío de correos no se tocan, y los QR ya enviados siguen funcionando igual.

## 1. Crear el script

1. Ve a https://script.google.com con la cuenta dueña de la hoja → **Nuevo proyecto**.
2. Ponle nombre: «Recepció Congrés».
3. Borra lo que haya en `Código.gs` y pega todo el contenido de [`Codi.gs`](Codi.gs).
4. Comprueba arriba del archivo, en `CONFIG`:
   - `ID_FULL_CALCUL`: el ID de tu hoja (ya está puesto el de tu hoja).
   - Nombres de las pestañas y columnas: ya coinciden con tu hoja (`Assistència Pagada` con datos desde la fila 3; `Assistència` con datos desde la fila 3).
   - `MODE`: `'unic'` (cada persona entra una vez en todo el congreso, como ahora) o `'diari'` (una vez cada día: 18, 19 y 20).
5. **Guardar** (icono del disquete).

## 2. Poner el código de acceso

Es la contraseña que escribirán tus compañeros de recepción. Sin ella, nadie puede consultar ni registrar nada.

1. Menú de la izquierda → **Configuración del proyecto** (rueda dentada).
2. Abajo del todo, **Propiedades del script** → **Añadir propiedad del script**.
3. Propiedad: `CODI_ACCES` · Valor: el código que quieras (por ejemplo, `EntreJoves-2026`). Mejor largo y sin espacios.
4. **Guardar propiedades del script**.

## 3. Probar que ve la hoja

1. Vuelve al **Editor** (icono `< >`).
2. Arriba, en el desplegable de funciones, elige **provarConfiguracio** → **Ejecutar**.
3. La primera vez Google pedirá permisos: **Revisar permisos** → tu cuenta → «Google no ha verificado esta aplicación» → **Configuración avanzada** → **Ir a Recepció Congrés (no seguro)** → **Permitir**. (Es tu propio script; el aviso sale siempre con scripts personales).
4. En el **Registro de ejecución** debe salir cuántos pagados hay y «Codi d'accés configurat ✔».

## 4. Publicarlo como aplicación web

1. Arriba a la derecha: **Implementar** → **Nueva implementación**.
2. En la rueda dentada de «Seleccionar tipo», elige **Aplicación web**.
3. Descripción: «Recepció» ·  **Ejecutar como: Yo** · **Quién tiene acceso: Cualquier usuario**.
   (Hace falta «cualquier usuario» para que la app funcione en los móviles de tus compañeros sin iniciar sesión en Google. La protección es el código de acceso: sin él la API no devuelve nada).
4. **Implementar** y copia la **URL de la aplicación web** (acaba en `/exec`).

## 5. Abrir la app y compartirla

- Abre la app de recepción (`https://zaka-atm.github.io/qr-event-attendance/`), escribe el código de acceso → **Entrar**.
- La URL `/exec` va en [`recepcio/config.js`](../recepcio/config.js) (`API_URL`), así nadie tiene que pegarla. **No pongas nunca el código de acceso en ese archivo** (es público).
- En el móvil, **Añadir a pantalla de inicio** para abrirla como una app.

## Si cambias el código de Codi.gs

**Implementar** → **Gestionar implementaciones** → lápiz → Versión: **Nueva versión** → **Implementar**. Así la URL `/exec` no cambia.

## Preguntas rápidas

- **¿Y si alguien registra con el sistema antiguo (el enlace del QR)?** La app lo detecta igual: busca el DNI en «Assistència», venga de donde venga.
- **¿Qué pasa si dos compañeros escanean el mismo QR a la vez?** Solo uno lo registra; el otro ve «No pot passar · Aquesta entrada ja s'ha utilitzat».
- **¿Y sin cobertura?** La app descarga la lista de pagados (el DNI va cifrado con un hash, no en claro), valida con ella y guarda los registros para enviarlos cuando vuelva la conexión. Si mientras tanto otra puerta ya había registrado a esa persona, aparece en **Més → Incidències**.
- **¿Toca otras columnas?** No: solo escribe A–E en «Assistència», igual que tu script actual.

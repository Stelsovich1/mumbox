import CloseIcon from "@mui/icons-material/Close";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Link,
  List,
  ListItemButton,
  ListItemText,
  Typography
} from "@mui/material";

type ProjectFaqDialogProps = {
  open: boolean;
  onClose: () => void;
};

const sections = [
  { id: "about", title: "О приложении" },
  { id: "import", title: "Добавление аудио" },
  { id: "library", title: "Медиатека и проекты" },
  { id: "workspace", title: "Рабочая область" },
  { id: "toolbar", title: "Правая панель" },
  { id: "modes", title: "Режимы воспроизведения" },
  { id: "editor", title: "Редактор аудиозаписи" },
  { id: "transfer", title: "Перенос на другой компьютер" }
] as const;

export function ProjectFaqDialog({ open, onClose }: ProjectFaqDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="lg"
      aria-labelledby="project-faq-title"
      slotProps={{
        paper: {
          sx: {
            width: { xs: "calc(100vw - 24px)", sm: "calc(100vw - 64px)" },
            maxWidth: { xs: "calc(100vw - 24px)", sm: "1200px" },
            maxHeight: { xs: "calc(100dvh - 24px)", sm: "calc(100dvh - 64px)" },
            m: { xs: 1.5, sm: 4 }
          }
        }
      }}
    >
      <DialogTitle
        id="project-faq-title"
        sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", pr: 1 }}
      >
        Документация MUMBOX
        <IconButton aria-label="Закрыть ЧАВО" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        <Box
          sx={{
            height: { xs: "68vh", md: "72vh" },
            display: "grid",
            gridTemplateColumns: { xs: "1fr", sm: "160px minmax(0, 1fr)", md: "240px minmax(0, 1fr)" },
            gridTemplateRows: { xs: "auto minmax(0, 1fr)", sm: "1fr" },
            minHeight: 0
          }}
        >
          <Box
            component="nav"
            aria-label="Оглавление ЧАВО"
            sx={{
              borderRight: 1,
              borderColor: "divider",
              backgroundColor: "rgba(5, 7, 13, 0.54)",
              overflowY: "auto",
              maxHeight: { xs: 116, sm: "none" }
            }}
          >
            <List dense disablePadding>
              {sections.map((section) => (
                <ListItemButton key={section.id} component={Link} href={`#${section.id}`} underline="none">
                  <ListItemText primary={section.title} />
                </ListItemButton>
              ))}
            </List>
          </Box>
          <Box
            sx={{
              overflowY: "auto",
              px: { xs: 2, md: 4 },
              py: 3,
              display: "grid",
              gap: 3,
              scrollBehavior: "smooth"
            }}
          >
            <Box id="about" component="section" sx={{ display: "grid", gap: 1 }}>
              <Typography variant="h5">О приложении</Typography>
              <Typography>
                MUMBOX - это кастомный пульт звуков для запуска локальных аудиофайлов с
                настраиваемых ячеек. Разработчик вдохновлялся мобильным приложением RemixLive:
                хотелось получить быстрый, отзывчивый инструмент для собственного набора
                звуков.
              </Typography>
              <Typography>
                Посвящается группе Stand Up Тула.
              </Typography>
            </Box>

            <Box id="import" component="section" sx={{ display: "grid", gap: 1 }}>
              <Typography variant="h5">Добавление аудио</Typography>
              <Typography>
                Через меню Проект можно импортировать один аудиофайл, несколько
                выбранных аудиофайлов или целую папку. После выбора открывается таблица импорта:
                в ней видно имя файла, длительность, быстрый preview, цвет и псевдоним. Цвет можно
                применить ко всем новым трекам из заголовка колонки или настроить отдельно для
                каждой строки.
              </Typography>
              <Typography>
                После нажатия Сохранить файлы попадают в медиатеку MUMBOX.
              </Typography>
              <Typography>
                Альтернативный способ: в режиме редактирования можно перетащить аудиофайлы или папку
                с аудиофайлами прямо на рабочее поле ячеек. Файлы автоматически добавятся в
                медиатеку и распределятся по свободным ячеям. Если свободных ячеек недостаточно,
                файлы все равно добавятся в медиатеку. При этом проверяются дубликаты и
                неподдерживаемые форматы — такие файлы пропускаются с соответствующим сообщением.
              </Typography>
            </Box>

            <Box id="library" component="section" sx={{ display: "grid", gap: 1 }}>
              <Typography variant="h5">Медиатека и проекты</Typography>
              <Typography>
                Медиатека - это список добавленных аудиозаписей внутри приложения: имя файла,
                псевдоним, цвет, длительность и служебный идентификатор. Сами аудиофайлы хранятся
                не по пути на диске, а в локальном браузерном хранилище IndexedDB. Поэтому уже
                добавленный трек продолжит работать, даже если исходный файл на жестком диске был
                перемещен или переименован.
              </Typography>
              <Typography>
                Экспорт проекта сохраняет один файл .mumbox: внутри него лежит раскладка панелей,
                размеры сеток, назначение ячеек, режимы воспроизведения, горячие клавиши, цвета,
                псевдонимы, настройки обработки аудио и сами аудиофайлы. Импорт проекта заменяет
                текущую рабочую раскладку и медиатеку на содержимое файла проекта.
              </Typography>
            </Box>

            <Box id="workspace" component="section" sx={{ display: "grid", gap: 1 }}>
              <Typography variant="h5">Рабочая область</Typography>
              <Typography>
                Рабочая область - это сетка квадратных ячеек. Пустая ячейка выглядит нейтрально, а
                ячейка с аудио показывает псевдоним или имя файла и индикатор режима. По умолчанию
                сетка 8x8, но для каждой вкладки можно выбрать другой размер.
              </Typography>
              <Typography>
                В режиме редактирования клик по ячейке открывает настройки справа. Там можно выбрать
                запись из медиатеки, поменять псевдоним, цвет, громкость, режим воспроизведения,
                горячую клавишу и параметры редактора аудио. Ячейки с назначенными записями можно
                перетаскивать по сетке; вместе с ячейкой переезжают все ее настройки.
              </Typography>
              <Typography>
                Кнопка Скопировать в настройках ячейки переносит копию в первую свободную ячейку
                выбранной панели. В режиме редактирования рядом с добавлением панели есть кнопка
                копирования панели: она создает новую панель с тем же размером сетки и всеми
                настроенными ячейками. Если имя копии не указано, используется суффикс _copy; при
                совпадении имен добавляется номер.
              </Typography>
              <Typography>
                Пустая панель удаляется сразу. Если в панели есть заполненные ячейки, перед
                удалением появляется подтверждение, чтобы случайно не потерять настроенную
                раскладку.
              </Typography>
              <Typography>
                Очистка заполненной или настроенной ячейки также требует подтверждения. Это
                действие убирает назначенный звук, псевдоним, цвет, горячую клавишу и параметры
                воспроизведения только у выбранной ячейки.
              </Typography>
            </Box>

            <Box id="toolbar" component="section" sx={{ display: "grid", gap: 1 }}>
              <Typography variant="h5">Правая панель</Typography>
              <Typography>
                Вертикальный регулятор громкости управляет общей громкостью приложения. Кнопка с
                блокнотом включает и выключает режим редактирования. Кнопка сетки выбирает размер
                текущей рабочей панели. Переключатель режима остановки определяет, могут ли играть
                несколько ячеек одновременно: если он включен, запуск новой ячейки останавливает
                предыдущую. Отдельная кнопка аварийного стопа мгновенно выключает все активные
                аудио.
              </Typography>
            </Box>

            <Box id="modes" component="section" sx={{ display: "grid", gap: 1 }}>
              <Typography variant="h5">Режимы воспроизведения</Typography>
              <Typography>
                Once запускает запись один раз. Повторный клик по играющей ячейке
                останавливает ее, следующий клик снова стартует с начала. Loop
                играет по кругу и также останавливается повторным кликом. Gate
                играет только пока зажата мышь, палец или горячая клавиша; если запись закончилась,
                пока нажатие удерживается, она стартует заново.
              </Typography>
              <Typography>
                Индикатор в ячейке показывает прогресс: круг для Loop, линия для Gate и линия с
                ограничителями для Once. Белая точка движется от 0% к 100% выбранного фрагмента.
              </Typography>
            </Box>

            <Box id="editor" component="section" sx={{ display: "grid", gap: 1 }}>
              <Typography variant="h5">Редактор аудиозаписи в ячейке</Typography>
              <Typography>
                В настройках ячейки над формой есть мини-волна аудио. Нажатие на нее открывает
                редактор конкретной ячейки. В редакторе можно задать начало и конец проигрываемого
                фрагмента, увеличить таймлайн для точной настройки, включить preview, зациклить
                preview, добавить плавное нарастание и затухание.
              </Typography>
              <Typography>
                Эти настройки относятся именно к выбранной ячейке. Один и тот же файл из медиатеки
                можно назначить в разные ячейки и в каждой обрезать или обработать по-своему.
                Кнопка Сбросить возвращает обработку этой ячейки к полному треку
                без fade in и fade out.
              </Typography>
            </Box>

            <Box id="transfer" component="section" sx={{ display: "grid", gap: 1 }}>
              <Typography variant="h5">Перенос на другой компьютер</Typography>
              <Typography>
                Практичная стратегия такая: на устройстве А импортируйте нужные аудиофайлы,
                настройте панели и выполните Экспорт проекта. Полученный .mumbox можно передать на
                другое устройство через AirDrop, облако, мессенджер, флешку или любой файловый
                обменник. На устройстве Б откройте меню Проект и выберите Импорт проекта.
              </Typography>
              <Typography>
                Так как аудио встраивается внутрь .mumbox, перенос работает между разными
                устройствами и ОС. Ограничения остаются браузерными: очень большие проекты могут
                требовать много памяти, а отдельные аудиоформаты могут не поддерживаться конкретным
                устройством. В таком случае MUMBOX покажет ошибку до импорта.
              </Typography>
            </Box>

            <Box component="footer" sx={{ pt: 2, borderTop: 1, borderColor: "divider" }}>
              <Typography color="text.secondary">
                Developer: Stelsovich1. <strong>Straight from the heart — for your soul.</strong>
              </Typography>
            </Box>
          </Box>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button variant="contained" onClick={onClose}>
          ОК
        </Button>
      </DialogActions>
    </Dialog>
  );
}

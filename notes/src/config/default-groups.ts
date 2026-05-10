export interface DefaultGroupDef {
	name: string
	description: string
}

export const DEFAULT_GROUPS: DefaultGroupDef[] = [
	{ name: 'Работа', description: 'Рабочие заметки, задачи, встречи' },
	{ name: 'Учёба', description: 'Конспекты, материалы для обучения' },
	{ name: 'Путешествия', description: 'Маршруты, впечатления, планы поездок' },
	{ name: 'Дом', description: 'Домашние дела, покупки, быт' },
	{ name: 'Разное', description: 'Всё остальное' },
]

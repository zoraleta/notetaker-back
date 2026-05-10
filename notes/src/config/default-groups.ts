export interface DefaultGroupDef {
	name: string
	description: string
	icon: string
	color: string
}

export const DEFAULT_GROUPS: DefaultGroupDef[] = [
	{ name: 'Работа', description: 'Рабочие заметки, задачи, встречи', icon: 'Briefcase', color: '#3b82f6' },
	{ name: 'Учёба', description: 'Конспекты, материалы для обучения', icon: 'BookOpen', color: '#22c55e' },
	{ name: 'Путешествия', description: 'Маршруты, впечатления, планы поездок', icon: 'Plane', color: '#f97316' },
	{ name: 'Дом', description: 'Домашние дела, покупки, быт', icon: 'Home', color: '#eab308' },
	{ name: 'Разное', description: 'Всё остальное', icon: 'Star', color: '#64748b' },
]

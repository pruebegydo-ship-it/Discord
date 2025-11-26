const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const axios = require('axios');
const JSZip = require('jszip');
const fs = require('fs');
const path = require('path');

const client = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

const comicSessions = new Map();

const userAgents = [
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

function getRandomUserAgent() {
	return userAgents[Math.floor(Math.random() * userAgents.length)];
}

function padNumber(num, padding) {
	return String(num).padStart(padding, '0');
}

function detectPaddingFromUrl(url) {
	const patterns = [
		/\{N\}/g,
		/_(\d+)\./,
		/-(\d+)\./,
		/\/(\d+)\./
	];

	for (let pattern of patterns) {
		const match = url.match(pattern);
		if (match && match[1]) {
			return match[1].length;
		}
	}
	return 2;
}

async function tryDownloadImage(url, retries = 2) {
	for (let i = 0; i < retries; i++) {
		try {
			const response = await axios.get(url, {
				responseType: 'arraybuffer',
				timeout: 10000,
				headers: {
					'User-Agent': getRandomUserAgent(),
					'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
					'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
					'Accept-Encoding': 'gzip, deflate, br',
					'Connection': 'keep-alive',
					'Cache-Control': 'no-cache',
					'Referer': url.split('/').slice(0, 3).join('/')
				}
			});

			if (response.status === 200 && response.data.length > 1000) {
				return { success: true, data: response.data };
			}
		} catch (error) {
			if (i === retries - 1) {
				return { success: false, error: error.message };
			}
			await new Promise(resolve => setTimeout(resolve, 500));
		}
	}
	return { success: false, error: 'Max retries reached' };
}

async function tryMultiplePaddings(template, number) {
	const paddings = [2, 1, 3, 4];

	for (let padding of paddings) {
		const numStr = padNumber(number, padding);
		const url = template.replace(/{N}/g, numStr);
		const result = await tryDownloadImage(url);

		if (result.success) {
			return { success: true, data: result.data, padding: padding, url: url };
		}
	}

	return { success: false };
}

async function downloadAllImages(template, interaction) {
	const zip = new JSZip();
	const folder = zip.folder('imagenes');
	let successful = 0;
	let consecutiveErrors = 0;
	let currentNumber = 1;
	let detectedPadding = null;
	let imageUrls = [];
	let lastUpdateTime = Date.now();

	const progressEmbed = new EmbedBuilder()
		.setTitle('📥 Buscando Imágenes')
		.setDescription('🔍 Iniciando búsqueda automática...\n\n**Encontradas:** 0')
		.setColor('#FFA500')
		.setTimestamp();

	await interaction.editReply({ embeds: [progressEmbed] });

	while (true) {
		if (consecutiveErrors >= 2) {
			break;
		}

		let result;

		if (detectedPadding === null) {
			result = await tryMultiplePaddings(template, currentNumber);
			if (result.success) {
				detectedPadding = result.padding;
			}
		} else {
			const numStr = padNumber(currentNumber, detectedPadding);
			const url = template.replace(/{N}/g, numStr);
			result = await tryDownloadImage(url);
			if (result.success) {
				result.url = url;
			}
		}

		if (result.success) {
			consecutiveErrors = 0;
			successful++;
			imageUrls.push(result.url);

			const ext = result.url.split('.').pop().split('?')[0];
			const filename = `imagen_${padNumber(currentNumber, detectedPadding)}.${ext}`;
			folder.file(filename, result.data);

			const now = Date.now();
			if (now - lastUpdateTime > 3000 || successful === 1) {
				lastUpdateTime = now;

				progressEmbed.setDescription(`🔍 Buscando y descargando...\n\n**Encontradas:** ${successful}\n**Actual:** ${padNumber(currentNumber, detectedPadding)}\n**Padding:** ${detectedPadding} dígitos`);

				if (successful === 1) {
					progressEmbed.setImage(imageUrls[0]);
				}

				await interaction.editReply({ embeds: [progressEmbed] }).catch(() => {});
			}
		} else {
			consecutiveErrors++;
		}

		currentNumber++;

		if (currentNumber > 9999) {
			break;
		}
	}

	if (successful === 0) {
		const errorEmbed = new EmbedBuilder()
			.setTitle('❌ Error')
			.setDescription('No se encontró ninguna imagen. Verifica la URL.\n\nAsegúrate de usar `{N}` donde va el número.\nEjemplo: `https://sitio.com/imagen_{N}.jpg`')
			.setColor('#FF0000')
			.setTimestamp();

		return await interaction.editReply({ embeds: [errorEmbed] });
	}

	progressEmbed.setDescription(`📦 Generando archivo ZIP con ${successful} imágenes...`);
	progressEmbed.setImage(null);
	await interaction.editReply({ embeds: [progressEmbed] });

	const zipBuffer = await zip.generateAsync({ 
		type: 'nodebuffer',
		compression: 'DEFLATE',
		compressionOptions: { level: 6 }
	});

	const tempPath = path.join(__dirname, `imagenes_${Date.now()}.zip`);
	fs.writeFileSync(tempPath, zipBuffer);

	const fileSize = (zipBuffer.length / (1024 * 1024)).toFixed(2);

	const attachment = new AttachmentBuilder(tempPath, { name: 'imagenes.zip' });

	const sessionId = `${interaction.user.id}_${Date.now()}`;
	comicSessions.set(sessionId, {
		images: imageUrls,
		currentPage: 0,
		userId: interaction.user.id
	});

	const finalEmbed = new EmbedBuilder()
		.setTitle('✅ Descarga Completada')
		.setDescription(`**Total de imágenes:** ${successful}\n**Rango:** ${padNumber(1, detectedPadding)} - ${padNumber(successful, detectedPadding)}\n**Tamaño:** ${fileSize} MB\n**Padding:** ${detectedPadding} dígitos`)
		.setColor('#00FF00')
		.setTimestamp();

	const viewButton = new ButtonBuilder()
		.setCustomId(`view_comic_${sessionId}`)
		.setLabel('📖 Ver Cómic')
		.setStyle(ButtonStyle.Primary);

	const row = new ActionRowBuilder().addComponents(viewButton);

	await interaction.editReply({ embeds: [finalEmbed], files: [attachment], components: [row] });

	setTimeout(() => {
		try {
			fs.unlinkSync(tempPath);
		} catch (err) {}
	}, 30000);

	setTimeout(() => {
		comicSessions.delete(sessionId);
	}, 600000);
}

function createComicEmbed(session) {
	const { images, currentPage } = session;
	const totalPages = images.length;

	const embed = new EmbedBuilder()
		.setTitle('📖 Visor de Cómic')
		.setDescription(`Página ${currentPage + 1} de ${totalPages}`)
		.setImage(images[currentPage])
		.setColor('#00A8FF')
		.setFooter({ text: `Usa los botones para navegar` })
		.setTimestamp();

	return embed;
}

function createNavigationButtons(sessionId, currentPage, totalPages) {
	const prevButton = new ButtonBuilder()
		.setCustomId(`comic_prev_${sessionId}`)
		.setLabel('◀️')
		.setStyle(ButtonStyle.Secondary)
		.setDisabled(currentPage === 0);

	const pageButton = new ButtonBuilder()
		.setCustomId(`comic_page_${sessionId}`)
		.setLabel(`${currentPage + 1}/${totalPages}`)
		.setStyle(ButtonStyle.Success)
		.setDisabled(true);

	const nextButton = new ButtonBuilder()
		.setCustomId(`comic_next_${sessionId}`)
		.setLabel('▶️')
		.setStyle(ButtonStyle.Secondary)
		.setDisabled(currentPage === totalPages - 1);

	const closeButton = new ButtonBuilder()
		.setCustomId(`comic_close_${sessionId}`)
		.setLabel('❌ Cerrar')
		.setStyle(ButtonStyle.Danger);

	const row = new ActionRowBuilder().addComponents(prevButton, pageButton, nextButton, closeButton);

	return row;
}

async function registerCommands() {
	const commands = [
		new SlashCommandBuilder()
			.setName('ping')
			.setDescription('Verifica que el bot esté funcionando'),

		new SlashCommandBuilder()
			.setName('descargar')
			.setDescription('Descarga TODAS las imágenes secuenciales automáticamente')
			.addStringOption(option =>
				option.setName('url')
					.setDescription('URL con {N} (ej: https://sitio.com/img_{N}.jpg)')
					.setRequired(true))
	];

	await client.application.commands.set(commands);
	console.log('✅ Comandos registrados');
}

client.once('ready', () => {
	console.log(`✅ Bot conectado: ${client.user.tag}`);
	console.log(`📍 Servidores: ${client.guilds.cache.size}`);
	console.log(`📍 Plataforma: ${process.platform}`);
	console.log(`📍 Node version: ${process.version}`);
	registerCommands();
});

client.on('interactionCreate', async (interaction) => {
	if (interaction.isChatInputCommand()) {
		if (interaction.commandName === 'ping') {
			const embed = new EmbedBuilder()
				.setTitle('🟢 Bot Activo')
				.setDescription(`**Latencia:** ${client.ws.ping}ms\n**Plataforma:** ${process.platform}\n**Node:** ${process.version}\n**Uptime:** ${Math.floor(client.uptime / 1000)}s`)
				.setColor('#00FF00')
				.setTimestamp();

			await interaction.reply({ embeds: [embed] });
		}

		if (interaction.commandName === 'descargar') {
			await interaction.deferReply();

			const url = interaction.options.getString('url');

			if (!url.includes('{N}')) {
				const errorEmbed = new EmbedBuilder()
					.setTitle('❌ Error en URL')
					.setDescription('La URL debe contener `{N}` donde va el número.\n\n**Ejemplos válidos:**\n`https://sitio.com/imagen_{N}.jpg`\n`https://pics.site.com/000/048/48414/{N}.webp`\n`https://cdn.comic.com/page_{N}.png`')
					.setColor('#FF0000');

				return await interaction.editReply({ embeds: [errorEmbed] });
			}

			await downloadAllImages(url, interaction);
		}
	}

	if (interaction.isButton()) {
		const [action, type, sessionId] = interaction.customId.split('_');

		if (action === 'view' && type === 'comic') {
			const session = comicSessions.get(sessionId);

			if (!session) {
				return await interaction.reply({ 
					content: '❌ Esta sesión ha expirado. Vuelve a usar `/descargar`.', 
					ephemeral: true 
				});
			}

			if (session.userId !== interaction.user.id) {
				return await interaction.reply({ 
					content: '❌ Solo quien descargó puede ver el cómic.', 
					ephemeral: true 
				});
			}

			const embed = createComicEmbed(session);
			const buttons = createNavigationButtons(sessionId, session.currentPage, session.images.length);

			await interaction.reply({ embeds: [embed], components: [buttons], ephemeral: true });
		}

		if (action === 'comic') {
			const session = comicSessions.get(sessionId);

			if (!session) {
				return await interaction.update({ 
					content: '❌ Esta sesión ha expirado.', 
					embeds: [], 
					components: [] 
				});
			}

			if (session.userId !== interaction.user.id) {
				return await interaction.reply({ 
					content: '❌ Solo quien descargó puede controlar el visor.', 
					ephemeral: true 
				});
			}

			if (type === 'prev' && session.currentPage > 0) {
				session.currentPage--;
			} else if (type === 'next' && session.currentPage < session.images.length - 1) {
				session.currentPage++;
			} else if (type === 'close') {
				return await interaction.update({ 
					content: '✅ Visor cerrado.', 
					embeds: [], 
					components: [] 
				});
			}

			const embed = createComicEmbed(session);
			const buttons = createNavigationButtons(sessionId, session.currentPage, session.images.length);

			await interaction.update({ embeds: [embed], components: [buttons] });
		}
	}
});

process.on('unhandledRejection', error => {
	console.error('❌ Error:', error);
});

console.log('🚀 Iniciando bot...');
client.login(process.env.DISCORD_TOKEN);

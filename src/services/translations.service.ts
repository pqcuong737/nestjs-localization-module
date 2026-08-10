import { Injectable, NotFoundException, BadRequestException, Logger, Inject, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not, In } from 'typeorm';
import { TranslationEntity } from '../entities/translations.entity';
import { CreateTranslationDto } from '../dtos/translation/create-translation.dto';
import { UpdateTranslationDto } from '../dtos/translation/update-translation.dto';
import { FilterTranslationDto } from '../dtos/translation/filter-translation.dto';
import { MissingTranslationDto } from '../dtos/translation/missing-translation.dto';
import { LanguageEntity } from '../entities/language.entity';
import { MicrosoftTranslatorService } from './microsoft-translator.service';
import { plainToClass } from 'class-transformer';
import { CONNECTION_NAME_TOKEN } from '../module/translations.module';

// Thêm các interface hỗ trợ
interface LanguageTranslationMap {
  [languageId: string]: TranslationEntity;
}

interface TranslationTask {
  language: LanguageEntity;
  existingTranslation?: TranslationEntity;
}

@Injectable()
export class TranslationsService {
  private readonly logger = new Logger(TranslationsService.name);
  private defaultLanguageCache: { code: string; timestamp: number } | null = null;
  private readonly DEFAULT_LANGUAGE_CACHE_TTL = 10 * 60 * 1000; // 10 phút
  private readonly MAX_BATCH_SIZE = 50; // Batch size tối ưu
  
  constructor(
    @InjectRepository(TranslationEntity)
    private readonly translationRepo: Repository<TranslationEntity>,
    @InjectRepository(LanguageEntity)
    private readonly languageRepo: Repository<LanguageEntity>,
    private readonly translatorService: MicrosoftTranslatorService,
    @Optional() @Inject(CONNECTION_NAME_TOKEN) private readonly connectionName?: string,
  ) {}

  /**
   * Get translations for a specific language and namespace
   * @param lang Language code
   * @param ns Namespace
   * @returns Object with key-value pairs of translations
   */
  async getTranslations(
    lang: string, 
    ns: string = 'translation'
  ): Promise<Record<string, string>> {
    try {
      // Optimize query: select only needed fields and use index
      const queryBuilder = this.translationRepo.createQueryBuilder('translation')
        .select(['translation.key', 'translation.value'])
        .innerJoin('translation.lang', 'lang')
        .where('lang.code = :lang', { lang })
        .andWhere('translation.ns = :ns', { ns });
      
      // Cache query result for frequently accessed namespaces
      if (['translation', 'common'].includes(ns)) {
        queryBuilder.cache(true, 60 * 5); // Cache for 5 minutes
      }
      
      const translations = await queryBuilder.getMany();
      
      // Use reduce for better performance with larger datasets
      return translations.reduce((acc, curr) => {
        acc[curr.key] = curr.value ?? '';
        return acc;
      }, {} as Record<string, string>);
    } catch (error) {
      this.logger.error(`Error getting translations: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }

  /**
   * Find translations with optional filtering
   * @param filterDto Filter criteria
   * @returns Array of translations
   */
  async findAll(filterDto?: FilterTranslationDto): Promise<TranslationEntity[]> {
    try {
      const queryBuilder = this.translationRepo.createQueryBuilder('translation')
        .leftJoinAndSelect('translation.lang', 'lang');
      
      if (filterDto) {
        // Optimize search using ILIKE for case-insensitive search
        if (filterDto.key) {
          queryBuilder.andWhere('translation.key ILIKE :key', { key: `%${filterDto.key}%` });
        }
        
        // Join language data only once
        if (filterDto.lang) {
          queryBuilder.andWhere('lang.code = :langCode', { langCode: filterDto.lang });
        }
        
        if (filterDto.ns) {
          queryBuilder.andWhere('translation.ns = :ns', { ns: filterDto.ns });
        }
      }
      
      // Add pagination for large datasets
      const page = filterDto?.page ? Math.max(1, Number(filterDto.page)) : 1;
      const limit = filterDto?.limit ? Math.min(100, Math.max(1, Number(filterDto.limit))) : 100;
      queryBuilder.skip((page - 1) * limit).take(limit);
      
      return await queryBuilder.getMany();
    } catch (error) {
      this.logger.error(`Error finding translations: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }

  /**
   * Create a new translation
   * @param createDto Translation data
   * @returns The created translation
   */
  async create(createDto: CreateTranslationDto): Promise<TranslationEntity> {
    try {
      // Validate required fields
      if (!createDto.key || !createDto.value || !createDto.lang) {
        throw new BadRequestException('Key, value, and language code are required');
      }

      // Normalize language code to handle case sensitivity issues
      const normalizedLangCode = createDto.lang.toLowerCase();
      
      // Find the corresponding language entity
      const language = await this.languageRepo.findOne({
        where: { code: normalizedLangCode },
        cache: 60 * 5 // Cache for 5 minutes
      });
      
      if (!language) {
        throw new NotFoundException(`Language with code ${createDto.lang} not found`);
      }
      
      // Check if translation already exists - optimize search with index
      const existingTranslation = await this.translationRepo.createQueryBuilder('translation')
        .where('translation.key = :key', { key: createDto.key })
        .andWhere('translation.ns = :ns', { ns: createDto.ns || 'translation' })
        .innerJoin('translation.lang', 'lang')
        .andWhere('lang.id = :langId', { langId: language.id })
        .getOne();

      if (existingTranslation) {
        throw new BadRequestException(
          `Translation with key '${createDto.key}' already exists for language '${createDto.lang}' in namespace '${createDto.ns || 'translation'}'`
        );
      }

      // Create the translation entity with proper relations
      const { lang, ...rest } = createDto;
      const translation = plainToClass(TranslationEntity, {
        ...rest,
        ns: rest.ns || 'translation', // Set default namespace if not provided
        lang: language, // Set the language entity relation
      });
      
      const result = await this.translationRepo.save(translation);
      
      // Automatically create translations for other languages if Microsoft Translator is configured
      // Do this in background to not block the main thread
      this.scheduleAutoTranslation(result).catch(error => {
        this.logger.error(`Background auto-translation failed: ${error.message}`);
      });
      
      return result;
    } catch (error) {
      this.logger.error(`Failed to create translation: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }

  /**
   * Update an existing translation
   * @param updateDto Translation data to update
   * @returns The updated translation
   */
  async updateTranslation(updateDto: UpdateTranslationDto): Promise<TranslationEntity> {
    try {
      // Validate DTO
      if (!updateDto.key || !updateDto.value || !updateDto.lang) {
        throw new BadRequestException('Key, value, and language code are required');
      }
      
      // Get language by code, use cached query where possible
      const language = await this.languageRepo.findOne({
        where: { code: updateDto.lang },
        cache: 60 * 5
      });
      
      if (!language) {
        throw new NotFoundException(`Language with code ${updateDto.lang} not found`);
      }
      
      // Optimize query with index
      const translation = await this.translationRepo.createQueryBuilder('translation')
        .where('translation.key = :key', { key: updateDto.key })
        .andWhere('translation.ns = :ns', { ns: updateDto.ns || 'translation' })
        .innerJoin('translation.lang', 'lang')
        .andWhere('lang.id = :langId', { langId: language.id })
        .getOne();
      
      if (!translation) {
        // If translation doesn't exist, create it
        return this.create(updateDto as CreateTranslationDto);
      }
      
      // Update translation value and category if provided
      translation.value = updateDto.value;
      
      const result = await this.translationRepo.save(translation);
      
      // Check if this is the default language, and if so, schedule auto-translation
      const defaultLangCode = await this.getCachedDefaultLanguageCode();
      if (updateDto.lang === defaultLangCode) {
        this.scheduleAutoTranslation(result).catch(error => {
          this.logger.error(`Background auto-translation failed: ${error.message}`);
        });
      }
      
      return result;
    } catch (error) {
      this.logger.error(`Error updating translation: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }

  /**
   * Add a translation
   * @param dto Missing translation data
   * @returns The created translation entity
   */
  async addTranslation(dto: MissingTranslationDto): Promise<TranslationEntity | null> {
    try {
      const ns = dto.ns || 'translation';
      
      const language = await this.languageRepo.findOne({
        where: { code: dto.lang },
        cache: 60 * 5
      });
      
      if (!language) {
        throw new NotFoundException(`Language with code ${dto.lang} not found`);
      }
      
      // Optimize query with index
      const existing = await this.translationRepo.createQueryBuilder('translation')
        .where('translation.key = :key', { key: dto.key })
        .andWhere('translation.ns = :ns', { ns })
        .innerJoin('translation.lang', 'lang')
        .andWhere('lang.id = :langId', { langId: language.id })
        .getOne();
      
      if (!existing) {
        const newTranslation = this.translationRepo.create({
          lang: language,
          ns: ns,
          key: dto.key,
          value: dto.key, // Set default value to the key since value is now required
        });
        
        const result = await this.translationRepo.save(newTranslation);
        
        // Check if this is the default language and if so, auto-translate to other languages
        const defaultLangCode = await this.getCachedDefaultLanguageCode();
        if (dto.lang === defaultLangCode) {
          this.scheduleAutoTranslation(result).catch(error => {
            this.logger.error(`Background auto-translation failed: ${error.message}`);
          });
        }
        
        return result;
      }
      
      return null;
    } catch (error) {
      this.logger.error(`Error adding translation: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }

  /**
   * Add multiple translations in batch
   * @param langCode Language code
   * @param ns Namespace
   * @param translations Key-value pairs of translations
   * @returns Number of translations added
   */
  async addManyTranslation(
    langCode: string, 
    ns: string, 
    translations: Record<string, string>
  ): Promise<number> {
    try {
      const language = await this.languageRepo.findOne({
        where: { code: langCode },
        cache: 60 * 5
      });
      
      if (!language) {
        throw new NotFoundException(`Language with code ${langCode} not found`);
      }
      
      // Get all keys from the translations object
      const keys = Object.keys(translations);
      
      if (keys.length === 0) return 0;
      
      // Find existing translations for these keys in one query
      const existingTranslations = await this.translationRepo.createQueryBuilder('translation')
        .where('translation.key IN (:...keys)', { keys })
        .andWhere('translation.ns = :ns', { ns })
        .innerJoin('translation.lang', 'lang')
        .andWhere('lang.id = :langId', { langId: language.id })
        .getMany();
      
      // Create a map of existing translations by key
      const existingTranslationMap = new Map<string, TranslationEntity>();
      existingTranslations.forEach(trans => {
        existingTranslationMap.set(trans.key, trans);
      });
      
      // Prepare new translations
      const newTranslations = [];
      
      for (const key of keys) {
        if (!existingTranslationMap.has(key)) {
          newTranslations.push({
            lang: language,
            ns,
            key,
            value: translations[key] || key
          });
        }
      }
      
      // Save all new translations in batch
      if (newTranslations.length > 0) {
        const entities = this.translationRepo.create(newTranslations);
        const savedTranslations = await this.translationRepo.save(entities);
        
        // Auto-translate if this is the default language
        const defaultLangCode = await this.getCachedDefaultLanguageCode();
        if (langCode === defaultLangCode) {
          // Process in smaller batches to prevent memory issues
          const batchSize = 5;
          for (let i = 0; i < savedTranslations.length; i += batchSize) {
            const batch = savedTranslations.slice(i, i + batchSize);
            await Promise.all(batch.map(translation => this.scheduleAutoTranslation(translation)));
          }
        }
        
        return savedTranslations.length;
      }
      
      return 0;
    } catch (error) {
      this.logger.error(`Error adding batch translations: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }

  /**
   * Get translation by ID
   * @param id Translation ID
   * @returns The translation entity
   */
  async findById(id: string): Promise<TranslationEntity> {
    try {
      const translation = await this.translationRepo.findOne({ 
        where: { id },
        relations: ['lang'] 
      });
      
      if (!translation) {
        throw new NotFoundException(`Translation with ID ${id} not found`);
      }
      
      return translation;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(`Error finding translation by ID: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }

  /**
   * Delete a translation
   * @param id Translation ID
   * @returns Boolean indicating success
   */
  async remove(id: string): Promise<boolean> {
    try {
      const translation = await this.findById(id);
      const result = await this.translationRepo.remove(translation);
      return !!result;
    } catch (error) {
      this.logger.error(`Error removing translation: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }

  /**
   * Get the default language code with caching
   * @returns The default language code or null if not found
   */
  private async getCachedDefaultLanguageCode(): Promise<string | null> {
    const now = Date.now();
    
    // Return from cache if valid
    if (this.defaultLanguageCache && 
        (now - this.defaultLanguageCache.timestamp) < this.DEFAULT_LANGUAGE_CACHE_TTL) {
      return this.defaultLanguageCache.code;
    }
    
    // Get from database
    const defaultLanguage = await this.languageRepo.findOne({
      where: { isDefault: true },
      cache: true
    });
    
    if (!defaultLanguage) {
      return null;
    }
    
    // Update cache
    this.defaultLanguageCache = {
      code: defaultLanguage.code,
      timestamp: now
    };
    
    return defaultLanguage.code;
  }

  /**
   * Batch translate texts using Microsoft Translator API
   * Optimized with chunking for large datasets
   */
  async batchTranslate(
    texts: string[],
    targetLang: string,
    sourceLang?: string
  ): Promise<{ key: string; value: string }[]> {
    try {
      // Check if the translator service is configured
      if (!this.translatorService.isConfigured()) {
        throw new Error('Microsoft Translator is not configured');
      }
      
      // Validate inputs
      if (!texts || texts.length === 0) {
        return [];
      }
      
      // Find target language to ensure it exists
      const targetLanguage = await this.languageRepo.findOne({
        where: { code: targetLang },
        cache: 60 * 5
      });
      
      if (!targetLanguage) {
        throw new NotFoundException(`Target language with code ${targetLang} not found`);
      }
      
      // If no source language provided, use the default language
      if (!sourceLang) {
        const defaultLangCode = await this.getCachedDefaultLanguageCode();
        if (!defaultLangCode) {
          throw new Error('No default language configured in the system');
        }
        sourceLang = defaultLangCode;
      } else {
        // Validate source language
        const sourceLanguage = await this.languageRepo.findOne({
          where: { code: sourceLang },
          cache: 60 * 5
        });
        
        if (!sourceLanguage) {
          throw new NotFoundException(`Source language with code ${sourceLang} not found`);
        }
      }
      
      // Process translations in batches to avoid overloading API and memory
      const translatedTexts: string[] = [];
      const batchSize = this.MAX_BATCH_SIZE;
      
      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        
        // Use Promise.all for parallel processing within each batch
        const batchPromises = batch.map(text => 
          this.translatorService.translate(text, targetLang, sourceLang as string)
        );
        
        try {
          const batchResults = await Promise.all(batchPromises);
          translatedTexts.push(...batchResults.map(result => result === null ? '' : result));
        } catch (batchError) {
          this.logger.error(`Error translating batch: ${batchError instanceof Error ? batchError.message : 'Unknown error'}`);
          // Add empty results for this batch and continue with next batch
          translatedTexts.push(...Array(batch.length).fill(''));
        }
      }
      
      // Transform results into the expected format with key and value properties
      return texts.map((text, index) => ({
        key: text,
        value: translatedTexts[index] || ''
      }));
    } catch (error) {
      this.logger.error(`Error during batch translation: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }

  /**
   * Schedule auto-translation in background
   * @param translation The source translation to auto-translate
   */
  private async scheduleAutoTranslation(translation: TranslationEntity): Promise<void> {
    // Run in next tick to not block the main thread
    setImmediate(() => {
      this.autoTranslateToOtherLanguages(translation).catch(error => {
        this.logger.error(`Auto-translation failed: ${error.message}`);
      });
    });
  }

  /**
   * Auto-translate a translation to all other active languages
   * @param translation The source translation
   */
  private async autoTranslateToOtherLanguages(translation: TranslationEntity): Promise<void> {
    // Skip if Microsoft Translator is not configured or if the value is empty
    if (!this.translatorService.isConfigured() || !translation.value) {
      return;
    }
    
    try {
      // Get source language
      const sourceLanguage = translation.lang;
      
      // Get all target languages at once - no need to filter here for speed
      const allLanguages = await this.languageRepo.find({ 
        where: { active: true }
      });
      
      // Filter languages directly in JS for speed
      const languages = allLanguages.filter(lang => lang.id !== sourceLanguage.id);
      if (languages.length === 0) return;
      
      // Extract language codes for translation 
      const targetLanguageCodes = languages.map(lang => lang.code);
      const sourceLanguageCode = sourceLanguage.code;
      
      // Translate to multiple languages at once
      const translationsMap = await this.translatorService.translateToMultipleLanguages(
        translation.value,
        targetLanguageCodes,
        sourceLanguageCode
      );
      
      // Prepare all translations at once
      const translationsToSave: TranslationEntity[] = [];
      
      for (const language of languages) {
        const translatedValue = translationsMap.get(language.code);
        
        // Skip if no translation
        if (!translatedValue) continue;
        
        // Create new translation entity
        const newTranslation = this.translationRepo.create({
          lang: language,
          ns: translation.ns,
          key: translation.key,
          value: translatedValue
        });
        
        translationsToSave.push(newTranslation);
      }
      
      // Save all translations in one batch
      if (translationsToSave.length > 0) {
        await this.translationRepo.save(translationsToSave);
      }
    } catch (error) {
      this.logger.error(`Error in autoTranslateToOtherLanguages: ${error instanceof Error ? error.message : 'Unknown error'}`);
      // Don't throw to avoid interrupting the flow
    }
  }

  /**
   * Find translations by keys in batch
   * @param keys Array of keys to find
   * @param lang Language code
   * @param ns Namespace
   * @returns Map of key to translation value
   */
  async findTranslationsByKeys(
    keys: string[],
    lang: string,
    ns: string = 'translation'
  ): Promise<Map<string, string>> {
    if (!keys || keys.length === 0) {
      return new Map();
    }

    try {
      // Get translations in a single optimized query
      const translations = await this.translationRepo.createQueryBuilder('translation')
        .select(['translation.key', 'translation.value'])
        .innerJoin('translation.lang', 'lang')
        .where('lang.code = :lang', { lang })
        .andWhere('translation.ns = :ns', { ns })
        .andWhere('translation.key IN (:...keys)', { keys })
        .cache(true, 60 * 5) // Cache for 5 minutes
        .getMany();

      // Build response map
      const resultMap = new Map<string, string>();
      translations.forEach(translation => {
        resultMap.set(translation.key, translation.value ?? '');
      });

      return resultMap;
    } catch (error) {
      this.logger.error(`Error finding translations by keys: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }

  /**
   * Find missing translation keys
   * @param keys Keys to check
   * @param lang Language code
   * @param ns Namespace
   * @returns Array of missing keys
   */
  async findMissingTranslationKeys(
    keys: string[],
    lang: string,
    ns: string = 'translation'
  ): Promise<string[]> {
    if (!keys || keys.length === 0) {
      return [];
    }

    try {
      // Get existing translations
      const translationsMap = await this.findTranslationsByKeys(keys, lang, ns);
      
      // Find missing keys
      return keys.filter(key => !translationsMap.has(key));
    } catch (error) {
      this.logger.error(`Error finding missing translation keys: ${error instanceof Error ? error.message : 'Unknown error'}`);
      throw error;
    }
  }
}

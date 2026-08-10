import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards, HttpStatus } from '@nestjs/common';
import { TranslationsService } from '../services/translations.service';
import { LocalizationAuthGuard } from '../guards/localization-auth.guard';
import { CreateTranslationDto } from '../dtos/translation/create-translation.dto';
import { UpdateTranslationDto } from '../dtos/translation/update-translation.dto';
import { FilterTranslationDto } from '../dtos/translation/filter-translation.dto';
import { MissingTranslationDto } from '../dtos/translation/missing-translation.dto';
import { BatchTranslateDto, BatchTranslateResponseDto } from '../dtos/translation/batch-translate.dto';
import { ParseStringParamPipe } from '../pipe/parse-string-param.pipe';

@Controller('translations')
@UseGuards(LocalizationAuthGuard)
export class TranslationsController {
  constructor(private readonly translationsService: TranslationsService) {}

  @Get('detail/:id')
  findById(@Param('id') id: string) {
    return this.translationsService.findById(id);
  }

  @Get(':lang/:ns')
  getTranslations(
    @Param('lang', new ParseStringParamPipe({ required: true, decodeUrl: true })) lang: string, 
    @Param('ns', new ParseStringParamPipe({ required: true, decodeUrl: true })) ns: string
  ) {
    return this.translationsService.getTranslations(lang, ns);
  }

  @Get()
  findAll(@Query() filterDto: FilterTranslationDto) {
    return this.translationsService.findAll(filterDto);
  }
  
  @Post()
  create(@Body() createDto: CreateTranslationDto) {
    return this.translationsService.create(createDto);
  }

  @Put()
  update(@Body() updateDto: UpdateTranslationDto) {
    return this.translationsService.updateTranslation(updateDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.translationsService.remove(id);
  }

  @Post('add-many/:lng/:ns')
  async addManyTranslation(
    @Param('lng') lng: string,
    @Param('ns') ns: string,
    @Body() inputs: Record<string, string>
  ) {
    const count = await this.translationsService.addManyTranslation(lng, ns, inputs);
    return count;
  }

  @Post('add-translation')
  addTranslation(@Body() dto: MissingTranslationDto) {
    return this.translationsService.addTranslation(dto);
  }

  @Post('batch-translate')
  // @UseGuards(JwtAuthGuard) // Optional: Add authentication if required
  // @ApiOperation({ summary: 'Batch translate multiple texts' })
  // @ApiResponse({
  //   status: 200,
  //   description: 'The texts have been translated successfully',
  //   type: BatchTranslateResponseDto
  // })
  // @ApiResponse({ status: 400, description: 'Invalid input data' })
  // @ApiResponse({ status: 404, description: 'Language not found' })
  // @ApiResponse({ status: 500, description: 'Translation service error' })
  async batchTranslate(@Body() batchTranslateDto: BatchTranslateDto): Promise<BatchTranslateResponseDto> {
    const translations = await this.translationsService.batchTranslate(
      batchTranslateDto.texts,
      batchTranslateDto.targetLang,
      batchTranslateDto.sourceLang
    );
    
    return { translations };
  }
}
